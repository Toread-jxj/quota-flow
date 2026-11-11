// 分镜编排后端模块：分镜文本解析 + 资产匹配 + 视频合并
// 默认 raw 照抄（不检测、不润色），让用户在 GUI 里直接 review 分镜词。
//
// 解析器规则（通用版，不再硬编码某个项目的资产前缀）：
//   - 段标题兼容「## V001｜00:00–00:15｜标题」（时码中置）与「## V001｜标题｜全片00:00—00:15」（时码后置）
//   - 资产引用 @前缀_… 前缀不限定（BT_/DK_/任意），到中文标点/空白/竖线为止
//   - 动作字段兼容「主要动作」（新版）与「画内主体及动作」（旧版）
//   - 对白兼容「第001句｜…｜ROLE｜源Sxx-Dxx：台词」（新版）与「D001｜…｜ROLE｜镜头N + 弯引号台词」（旧版）
//   - 破折号 em-dash / en-dash / 连字符 全部兼容

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
const DUR_SLOTS = [5, 10, 15]
// 时码/秒区间里的破折号统一兼容 em-dash — / en-dash – / 连字符 -
const DASH = '[-–—]'

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
  let t = s.replace(/@[^\s｜|，。；：、]+/g, '')
  t = t.replace(/[｜|]\s*/g, '，')
  for (const kw of ['拟交付名', '未批准', '未绑定', '未存在', '待美术']) {
    t = t.replace(new RegExp(`[^，。；]*${kw}[^；。]*[；。]?`, 'g'), '')
  }
  return t.replace(/^[，。；\s]+|[，。；\s]+$/g, '')
}

// 友好标签：从 @引用名 提炼人眼可读标签（前缀_类型_名称_…）
function friendlyLabel(stem: string): string {
  const parts = stem.split('_')
  if (parts.length < 3) return stem
  const typ = (parts[1] || '?')[0] || '?'
  if (typ === 'C') {
    const name = parts[2]
    const ver = parts.find((p) =>
      ['日一工作装', '三周后日常装', '渡船工作装', 'NIGHT', 'DAY', 'MORNING'].includes(p)
    )
    return ver ? `${name}${ver}` : name
  }
  return parts[2] || stem
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
    body.match(
      new RegExp(`【固定镜头\\d+｜[\\d.]+${DASH}[\\d.]+秒】[\\s\\S]*?(?=【固定镜头|【C层|【末帧|【本段)`, 'g')
    ) || []
  const shots: ParsedLens[] = []
  for (const b of shotBlocks) {
    const hd = b.match(new RegExp(`【固定镜头(\\d+)｜([\\d.]+)${DASH}([\\d.]+)秒】`))
    const no = hd ? parseInt(hd[1], 10) : shots.length + 1
    const dur = hd ? parseFloat(hd[3]) - parseFloat(hd[2]) : 5
    const act =
      b.match(/主要动作[：:]\s*([\s\S]*?)(?=[。]?表演触发|[。]?对白覆盖|$)/) ||
      b.match(/画内主体及动作[：:]\s*([\s\S]*?)(?=[。]?对白对应|$)/)
    shots.push({ no, dur, action: act ? act[1].trim().replace(/。$/, '') : '' })
  }

  const dials: ParsedDial[] = []
  // 新格式：第001句｜0.15—5.91秒｜LILY｜源S01-D01：Is this...（台词在冒号后同行）
  const newDialRe = new RegExp(`第\\d+句｜[\\d.]+${DASH}[\\d.]+秒｜([A-Z]+)｜源[^：:\\n]*[：:]\\s*([^\\n]+)`, 'g')
  let dm
  while ((dm = newDialRe.exec(body)) !== null) {
    const role = dm[1]
    const line = dm[2].trim()
    if (line && !dials.some((d) => d.role === role && d.line === line)) {
      dials.push({ role, shot: 0, line })
    }
  }
  // 旧格式：D001｜7.04—9.21秒｜NORA｜镜头3｜…（台词在后续弯引号里）
  const oldDialRe = new RegExp(`D\\d+｜[\\d.]+${DASH}[\\d.]+秒｜([A-Z]+)｜镜头(\\d+)`, 'g')
  while ((dm = oldDialRe.exec(body)) !== null) {
    const role = dm[1]
    const shot = parseInt(dm[2], 10)
    const after = body.slice(dm.index + dm[0].length, dm.index + dm[0].length + 300)
    const line = after.match(/\u201c([^\u201d]+)\u201d/)
    if (line && !dials.some((d) => d.role === role && d.line === line[1])) {
      dials.push({ role, shot, line: line[1] })
    }
  }

  // 资产引用：@前缀_…，前缀不限定，到中文标点/空白/竖线为止
  const refs: string[] = []
  const refRe = /@([A-Za-z0-9_][-\w\u4e00-\u9fa5]*)/g
  let rm
  while ((rm = refRe.exec(body)) !== null) {
    const name = rm[1]
    if (name && !refs.includes(name)) refs.push(name)
  }

  return { scene, shots, dials, refs }
}

// ---- 照抄版 prompt（方向2：整段原文照抄，仅把 @资产引用 替换成 [图N：标签]，不做重组/过滤）----
function buildRawPrompt(body: string, refs: string[], refLabels: string[]): string {
  let prompt = body
  refs.forEach((ref, i) => {
    const label = refLabels[i] || ref
    prompt = prompt.split('@' + ref).join(`[图${i + 1}：${label}]`)
  })
  return prompt
}

/** 解析段标题行：兼容「## V001｜00:00–00:15｜标题」（时码中置）与「## V001｜标题｜全片00:00—00:15」（时码后置） */
function parseHeading(line: string): { id: string; title: string; fromT: string; toT: string } | null {
  const m = line.match(/^##\s*(V\d+)[｜|]\s*(.+?)[｜|]\s*(.+?)\s*$/)
  if (!m) return null
  const f2 = m[2].trim()
  const f3 = m[3].trim()
  const timeRe = new RegExp(`^(\\d+:\\d+(?:\\.\\d+)?)${DASH}(\\d+:\\d+(?:\\.\\d+)?)$`)
  const t2 = f2.match(timeRe)
  const t3 = f3.replace(/^全片\s*/, '').match(timeRe)
  if (t2) return { id: m[1], title: f3, fromT: t2[1], toT: t2[2] }
  if (t3) return { id: m[1], title: f2, fromT: t3[1], toT: t3[2] }
  return { id: m[1], title: f2, fromT: '0:0', toT: '0:15' }
}

// ---- 主解析：文本 → 结构化 shots（默认 raw）----
export function parseStoryboardText(text: string): StoryboardShot[] {
  const segRe = /^##\s*(V\d+)[｜|]/gm
  const shots: StoryboardShot[] = []
  const starts: number[] = []
  let index = 1
  let m
  while ((m = segRe.exec(text)) !== null) starts.push(m.index)

  for (let i = 0; i < starts.length; i++) {
    const from = starts[i]
    const end = i + 1 < starts.length ? starts[i + 1] : text.length
    const segText = text.slice(from, end)
    const nl = segText.indexOf('\n')
    const headingLine = nl === -1 ? segText : segText.slice(0, nl)
    const h = parseHeading(headingLine)
    if (!h) continue

    const body = segText
    const { scene, shots: lens, dials, refs } = parseSegment(body)
    const dur = toSec(h.toT) - toSec(h.fromT)
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
      prompt: buildRawPrompt(body, refs, refLabels)
    })

    if (dur <= 15 || lens.length <= 1) {
      shots.push(mk(h.id, h.title, lens, dials, lens.map((x) => x.action), dials))
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
      shots.push(mk(`${h.id}a`, `${h.title}（前段）`, l1, d1, l1.map((x) => x.action), d1))
      shots.push(mk(`${h.id}b`, `${h.title}（后段）`, l2, d2, l2.map((x) => x.action), d2))
    }
  }
  return shots
}

// ---- 扫描工作目录找分镜文本（.md 文件）----
// 分镜词默认放工作目录根：根目录有 .md 就只认根目录（不把资产子文件夹里的说明 md 误当分镜词）；
// 根目录没有时才递归兜底。
export async function findStoryboardFiles(workDir: string): Promise<string[]> {
  let entries
  try {
    entries = await readdir(workDir, { withFileTypes: true })
  } catch {
    return []
  }
  const rootMd = entries
    .filter((e) => e.isFile() && /\.md$/i.test(e.name))
    .map((e) => join(workDir, e.name))
  if (rootMd.length > 0) return rootMd

  const result: string[] = []
  const walk = async (dir: string): Promise<void> => {
    let es
    try {
      es = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of es) {
      const full = join(dir, e.name)
      if (e.isDirectory()) await walk(full)
      else if (e.isFile() && /\.md$/i.test(e.name)) result.push(full)
    }
  }
  await walk(workDir)
  return result
}

// ---- 资产匹配：递归扫描工作目录下所有图片，建立 stem→path，用 refs 分级匹配 ----
// 三级匹配（从严格到宽松）：
//   1) 精确：文件 stem == 引用名
//   2) 去版本：双方去掉尾部 _vNN（版本号）后相等
//   3) 前缀：文件 stem 以引用名开头（引用名是文件名的前缀，文件可能带额外说明后缀）
function normalizeStem(stem: string): string {
  return stem.replace(/[_-]v\d+([._-]\d+)?$/i, '')
}

export async function matchAssets(refs: string[], workDir: string): Promise<string[]> {
  const exact = new Map<string, string>()
  const normalized = new Map<string, string>()
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
        const stem = e.name.replace(/\.[^.]+$/, '')
        exact.set(stem, full)
        const norm = normalizeStem(stem)
        if (!normalized.has(norm)) normalized.set(norm, full)
      }
    }
  }
  await walk(workDir)

  return refs
    .map((r) => {
      if (exact.has(r)) return exact.get(r)!
      const nr = normalizeStem(r)
      if (normalized.has(nr)) return normalized.get(nr)!
      for (const [stem, p] of exact) {
        if (stem.startsWith(r)) return p
      }
      return ''
    })
    .filter((p): p is string => !!p)
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
