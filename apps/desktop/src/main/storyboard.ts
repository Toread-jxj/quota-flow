// 分镜编排后端模块：分镜文本解析 + 资产匹配 + 视频合并
// 默认 raw 照抄（不检测、不润色），让用户在 GUI 里直接 review 分镜词。

import { readdir, writeFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { join, basename, extname } from 'node:path'
import { promisify } from 'node:util'
import { resolveFfmpegPath } from './watermark-remover/engine'

const exec = promisify(execFile)

// ---- 类型 ----
export interface StoryboardDialogue {
  role: string
  line: string
}

export interface StoryboardShot {
  index: number
  id: string
  title: string
  durationSec: number
  scene: string
  actions: string[]
  dialogue: StoryboardDialogue[]
  refs: string[]
  images: string[] // 资产绝对路径（匹配后）
  prompt: string // 照抄版（raw，直接喂豆包）
}

export interface StoryboardParseResult {
  batchId: string
  provider: string
  shots: StoryboardShot[]
}

// ---- 常量 ----
const VOICE: Record<string, string> = {
  NORA: '38岁英国女性，克制清楚',
  EVAN: '32岁英国男性，自然中低音、疲惫但不冷漠',
  RUTH: '58岁英国女性，清晰平稳',
  HELEN: '约60岁女性，亲切普通',
  TOM: '约70岁男性，平常含蓄'
}

const STYLE_PREFIX =
  '16:9横屏，欧美真人写实，自然速度，固定机位无镜头运动。自然皮肤细节、可信重量与真实尺度材质，宽而柔和明暗，低对比、克制锐度，无游戏渲染。'

const DUR_SLOTS = [5, 10, 15]

function snapDuration(d: number): number {
  for (const s of DUR_SLOTS) if (d <= s) return s
  return 15
}

function toSec(t: string): number {
  const p = t.split(':')
  return parseFloat(p[0]) * 60 + parseFloat(p[1])
}

function escapeReg(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function grab(body: string, label: string): string {
  const m = body.match(new RegExp(`【${escapeReg(label)}】(.*?)(?=【|$)`, 's'))
  return m ? m[1].trim() : ''
}

function stripRefs(s: string): string {
  let t = s.replace(/@[^｜\s]+/g, '')
  t = t.replace(/[｜|]\s*/g, '，')
  for (const kw of ['拟交付名', '未批准', '未绑定', '未存在', '待美术']) {
    t = t.replace(new RegExp(`[^，。；]*${kw}[^；。]*[；。]?`, 'g'), '')
  }
  return t.replace(/^[，。；\s]+|[，。；\s]+$/g, '')
}

function friendlyLabel(stem: string): string {
  const parts = stem.split('_')
  if (parts.length < 3) return stem
  const typ = parts[1][0] || '?'
  if (typ === 'C') {
    const name = parts[2]
    const ver = parts.find((p) => ['日一工作装', '三周后日常装', '渡船工作装'].includes(p))
    return ver ? `${name}${ver}` : name
  }
  return parts[2]
}

// ---- 单段解析 ----
interface ParsedLens { no: number; dur: number; action: string }
interface ParsedDial { role: string; shot: number; line: string }

function parseSegment(body: string): {
  scene: string
  shots: ParsedLens[]
  dials: ParsedDial[]
  refs: string[]
} {
  const scene = stripRefs(grab(body, '场景')).split('。')[0]

  const shotBlocks =
    body.match(/【固定镜头\d+｜[\d.]+—[\d.]+秒】[\s\S]*?(?=【固定镜头|【C层|【末帧|【本段)/g) || []
  const shots: ParsedLens[] = []
  for (const b of shotBlocks) {
    const hd = b.match(/【固定镜头(\d+)｜([\d.]+)—([\d.]+)秒】/)
    const no = hd ? parseInt(hd[1], 10) : shots.length + 1
    const dur = hd ? parseFloat(hd[3]) - parseFloat(hd[2]) : 5
    const act = b.match(/画内主体及动作[：:]\s*([\s\S]*?)(?:[。]?对白对应|$)/)
    shots.push({ no, dur, action: act ? act[1].trim().replace(/。$/, '') : '' })
  }

  const dials: ParsedDial[] = []
  const dialRe = /D\d+｜[\d.]+—[\d.]+秒｜([A-Z]+)｜镜头(\d+)/g
  let dm
  while ((dm = dialRe.exec(body)) !== null) {
    const role = dm[1]
    const shot = parseInt(dm[2], 10)
    const after = body.slice(dm.index + dm[0].length, dm.index + dm[0].length + 300)
    const line = after.match(/\u201c([^\u201d]+)\u201d/)
    if (line) dials.push({ role, shot, line: line[1] })
  }

  const refs: string[] = []
  const refRe = /@([A-Za-z0-9_]+[^\s｜|，。；、]*)/g
  let rm
  while ((rm = refRe.exec(body)) !== null) {
    const name = rm[1]
    if (name.startsWith('BT_') && !refs.includes(name)) refs.push(name)
  }

  return { scene, shots, dials, refs }
}

// ---- 照抄拼接版 prompt ----
function buildRawPrompt(
  scene: string,
  lens: ParsedLens[],
  dials: ParsedDial[],
  refLabels: string[]
): string {
  const act = lens.map((s) => s.action).filter(Boolean).join(' ')
  const dial = dials.map((d) => `${d.role}（${VOICE[d.role] || ''}）说：“${d.line}”`).join(' ')
  const imgs = refLabels.map((l, i) => `[图${i + 1}：${l}]`).join(' ')
  const lines = [STYLE_PREFIX, `场景：${scene}。`, `动作：${act}`]
  if (dial) lines.push(`对白：${dial}`)
  if (imgs) lines.push(`参考图：${imgs}`)
  return lines.join('\n')
}

// ---- 主解析：文本 → 结构化 shots（默认 raw）----
export function parseStoryboardText(text: string): StoryboardShot[] {
  const segRe = /^## (V\d+)｜(.+?)｜全片(\d+:\d+(?:\.\d+)?)—(\d+:\d+(?:\.\d+)?)/gm
  const shots: StoryboardShot[] = []
  let index = 1
  let m
  while ((m = segRe.exec(text)) !== null) {
    const from = m.index + m[0].length
    const nm = /^## V\d+｜/m.exec(text.slice(from))
    const end = nm ? from + nm.index : text.length
    const body = text.slice(m.index, end)
    const { scene, shots: lens, dials, refs } = parseSegment(body)
    const dur = toSec(m[4]) - toSec(m[3])
    const refLabels = refs.map((r) => friendlyLabel(r))

    const mk = (
      id: string,
      title: string,
      l: ParsedLens[],
      d: ParsedDial[],
      actionsField: string[],
      dialsField: ParsedDial[]
    ): StoryboardShot => ({
      index: index++,
      id,
      title,
      durationSec: snapDuration(l.reduce((s, x) => s + x.dur, 0)),
      scene,
      actions: actionsField,
      dialogue: dialsField.map((x) => ({ role: x.role, line: x.line })),
      refs,
      images: [],
      prompt: buildRawPrompt(scene, l, dialsField, refLabels)
    })

    if (dur <= 15 || lens.length <= 1) {
      shots.push(mk(m[1], m[2], lens, dials, lens.map((x) => x.action), dials))
    } else {
      let cum = 0
      let cut = lens.length - 1
      for (let i = 0; i < lens.length; i++) {
        cum += lens[i].dur
        if (cum > 15 && i > 0) { cut = i; break }
      }
      const l1 = lens.slice(0, cut)
      const l2 = lens.slice(cut)
      const d1 = dials.filter((d) => d.shot <= cut)
      const d2 = dials.filter((d) => d.shot > cut)
      shots.push(mk(`${m[1]}a`, `${m[2]}（前段）`, l1, d1, l1.map((x) => x.action), d1))
      shots.push(mk(`${m[1]}b`, `${m[2]}（后段）`, l2, d2, l2.map((x) => x.action), d2))
    }
  }
  return shots
}

// ---- 扫描工作目录找分镜文本（.md 文件）----
export async function findStoryboardFiles(workDir: string): Promise<string[]> {
  const result: string[] = []
  const walk = async (dir: string): Promise<void> => {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const full = join(dir, e.name)
      if (e.isDirectory()) await walk(full)
      else if (e.isFile() && /\.md$/i.test(e.name)) result.push(full)
    }
  }
  await walk(workDir)
  return result
}

// ---- 资产匹配：递归扫描工作目录下所有 .png，建立 stem→path，用 refs 匹配 ----
export async function matchAssets(refs: string[], workDir: string): Promise<string[]> {
  const stem2path = new Map<string, string>()
  const walk = async (dir: string): Promise<void> => {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const full = join(dir, e.name)
      if (e.isDirectory()) await walk(full)
      else if (e.isFile() && /\.(png|jpe?g|webp)$/i.test(e.name)) {
        stem2path.set(e.name.replace(/\.[^.]+$/, ''), full)
      }
    }
  }
  await walk(workDir)
  return refs.map((r) => stem2path.get(r)).filter((p): p is string => !!p)
}

// ---- 合并多段视频（ffmpeg concat）----
export async function mergeVideos(videoPaths: string[], outPath: string): Promise<void> {
  if (videoPaths.length === 0) throw new Error('没有可合并的视频')
  const ffmpeg = resolveFfmpegPath()
  if (!ffmpeg) throw new Error('未找到 FFmpeg')
  const listFile = `${outPath}.list.txt`
  const list = videoPaths.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join('\n')
  await writeFile(listFile, list, 'utf8')
  try {
    await exec(ffmpeg, ['-y', '-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', outPath])
  } catch {
    await exec(ffmpeg, [
      '-y', '-f', 'concat', '-safe', '0', '-i', listFile,
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-an', outPath
    ])
  } finally {
    await rm(listFile, { force: true })
  }
}

// ---- 辅助：确保目录存在（供 IPC 层建输出目录）----
export function shotFileName(index: number): string {
  return `shot_${String(index).padStart(3, '0')}.mp4`
}
