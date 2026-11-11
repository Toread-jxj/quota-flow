// 分镜编排后端模块：分镜文本解析 + 资产匹配 + 视频合并
// 默认 raw 照抄（不检测、不润色），让用户在 GUI 里直接 review 分镜词。
//
// 解析器规则（通用版，只依赖分镜词的「结构共性」，不硬编码某个项目的写法）：
//   从 BT（旧）与 DK（新）两套分镜词提炼的稳定结构：
//   - 分段标题  ## Vxxx｜…          （段号字母+数字）
//   - 栏目      【栏目名[｜补充]】    （稳定）
//   - 资产引用  @标识符              （前缀项目相关，不锁）
//   - 镜头      【…镜头N…｜时码】     （「镜头」稳定，「固定」是修饰）
//   - 对白      ｜ROLE｜ + 台词      （竖线角色 + 弯引号/冒号后台词）
//   - 动作      镜头块内「动作：」字段
//   - 破折号 em-dash / en-dash / 连字符 全部兼容

import { readdir, writeFile, rm, readFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { join } from 'node:path'
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

/**
 * 提取对白：不依赖编号格式（D001 / 第001句 都行）。
 * 共性：对白在含「对白」的栏目里，角色名是竖线包围的英文标识符，
 *       台词要么在后续弯引号「“…”」里（旧），要么在该行冒号后（新）。
 */
function extractDialogues(body: string): ParsedDial[] {
  const cLayer = body.match(/【[^】]*对白[^】]*】([\s\S]*?)(?=【)/)
  const text = cLayer ? cLayer[1] : ''
  const dials: ParsedDial[] = []
  const seen = new Set<string>()
  const roleRe = /｜([A-Za-z][A-Za-z0-9_-]*)｜/g
  let m
  while ((m = roleRe.exec(text)) !== null) {
    const role = m[1]
    if (/^(NIGHT|DAWN|DAY|MORNING|AM|PM)$/i.test(role)) continue
    const after = text.slice(m.index + m[0].length, m.index + m[0].length + 400)
    let line = ''
    const q = after.match(/\u201c([^\u201d]+)\u201d/)
    if (q) line = q[1].trim()
    else {
      const c = after.match(/[：:]\s*([^\n]*)/)
      if (c && /[A-Za-z]/.test(c[1])) line = c[1].trim()
    }
    if (line && !seen.has(role + '|' + line)) {
      seen.add(role + '|' + line)
      dials.push({ role, shot: 0, line })
    }
  }
  return dials
}

function parseSegment(body: string): {
  scene: string
  shots: ParsedLens[]
  dials: ParsedDial[]
  refs: string[]
} {
  const scene = stripRefs(grab(body, '场景')).split('。')[0]

  // 镜头：任何含「镜头」的【标题】+ 后续内容（到下一个【为止）。
  const shots: ParsedLens[] = []
  const headRe = /【([^】]*镜头[^】]*)】/g
  const heads: { index: number; len: number; head: string }[] = []
  let hm
  while ((hm = headRe.exec(body)) !== null) heads.push({ index: hm.index, len: hm[0].length, head: hm[1] })
  for (let i = 0; i < heads.length; i++) {
    const from = heads[i].index + heads[i].len
    const end = i + 1 < heads.length ? heads[i + 1].index : body.length
    let content = body.slice(from, end)
    const cut = content.indexOf('【')
    if (cut >= 0) content = content.slice(0, cut)
    const noM = heads[i].head.match(/镜头\s*(\d+)/)
    const tm = heads[i].head.match(new RegExp(`([\\d.]+)${DASH}([\\d.]+)秒?`))
    const no = noM ? parseInt(noM[1], 10) : i + 1
    const dur = tm ? parseFloat(tm[2]) - parseFloat(tm[1]) : 5
    const act = content.match(/动作[：:]\s*([\s\S]*?)(?=[。]?(?:表演触发|对白覆盖|对白对应|切点))/)
    shots.push({ no, dur, action: act ? act[1].trim().replace(/[。\s]+$/, '') : '' })
  }

  const dials = extractDialogues(body)

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

// ---- 照抄版 prompt（整段原文照抄，仅把 @资产引用 替换成 [图N：标签]，不做重组/过滤）----
function buildRawPrompt(body: string, refs: string[], refLabels: string[]): string {
  let prompt = body
  refs.forEach((ref, i) => {
    const label = refLabels[i] || ref
    prompt = prompt.split('@' + ref).join(`[图${i + 1}：${label}]`)
  })
  return prompt
}

/** 解析段标题行：从「## V001｜字段1｜字段2」中识别时码（分:秒）与标题，不假设位置 */
function parseHeading(line: string): { id: string; title: string; fromT: string; toT: string } | null {
  const m = line.match(/^##\s*([A-Za-z]+\d+)[｜|]\s*(.+?)[｜|]\s*(.+?)\s*$/)
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

/** 从正文提取项目名（书名号《…》），用于无 ## 标题的单段分镜词 */
function extractTitle(body: string): string {
  const t = body.match(/《([^》]+)》/)
  return t ? t[1] : '分镜'
}

/** 内容打分：判断 .md 文本是否像分镜词（靠结构特征，不靠文件名） */
function storyboardScore(text: string): number {
  let score = 0
  if (/^##\s*[A-Za-z]+\d+[｜|]/m.test(text)) score += 3 // 分段标题
  if (/【[^】]*镜头[^】]*】/.test(text)) score += 3 // 镜头栏目（核心特征）
  if ((text.match(/【[^】]+】/g) || []).length >= 3) score += 2 // 多个栏目
  if (/【[^】]*对白[^】]*】/.test(text)) score += 1 // 对白栏目
  if (/@[A-Za-z0-9_]/.test(text)) score += 1 // 资产引用
  if (/动作[：:]/.test(text)) score += 1 // 动作字段
  return score
}

// ---- 主解析：文本 → 结构化 shots（默认 raw）----
export function parseStoryboardText(text: string): StoryboardShot[] {
  const segRe = /^##\s*([A-Za-z]+\d+)[｜|]/gm
  const starts: number[] = []
  let m
  while ((m = segRe.exec(text)) !== null) starts.push(m.index)

  const shots: StoryboardShot[] = []
  let index = 1

  const pushSeg = (body: string, id: string, title: string, dur: number): void => {
    const { scene, shots: lens, dials, refs } = parseSegment(body)
    const refLabels = refs.map((r) => friendlyLabel(r))
    const mk = (
      sid: string,
      stitle: string,
      l: ParsedLens[],
      d: ParsedDial[],
      actionsField: string[],
      dialsField: ParsedDial[]
    ): StoryboardShot => ({
      index: index++,
      id: sid,
      title: stitle,
      durationSec: snapDuration(l.reduce((s, x) => s + x.dur, 0)),
      scene,
      actions: actionsField,
      dialogue: dialsField.map((x) => ({ role: x.role, line: x.line })),
      refs,
      images: [],
      prompt: buildRawPrompt(body, refs, refLabels)
    })

    if (dur <= 15 || lens.length <= 1) {
      shots.push(mk(id, title, lens, dials, lens.map((x) => x.action), dials))
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
      shots.push(mk(`${id}a`, `${title}（前段）`, l1, d1, l1.map((x) => x.action), d1))
      shots.push(mk(`${id}b`, `${title}（后段）`, l2, d2, l2.map((x) => x.action), d2))
    }
  }

  // 无 ## 分段标题：整个文本当作单段分镜词
  if (starts.length === 0) {
    const parsed = parseSegment(text)
    const dur = parsed.shots.reduce((s, x) => s + x.dur, 0)
    pushSeg(text, 'V001', extractTitle(text), dur)
    return shots
  }

  for (let i = 0; i < starts.length; i++) {
    const from = starts[i]
    const end = i + 1 < starts.length ? starts[i + 1] : text.length
    const segText = text.slice(from, end)
    const nl = segText.indexOf('\n')
    const headingLine = nl === -1 ? segText : segText.slice(0, nl)
    const h = parseHeading(headingLine)
    if (!h) continue
    pushSeg(segText, h.id, h.title, toSec(h.toT) - toSec(h.fromT))
  }
  return shots
}

// ---- 扫描工作目录找分镜文本（.md 文件）----
// 分镜词默认放工作目录根：根目录有 .md 就只认根目录（不把资产子文件夹里的说明 md 误当分镜词）；
// 根目录没有时才递归兜底。
export async function findStoryboardFiles(workDir: string): Promise<string[]> {
  // 收集候选 .md（根目录优先，递归兜底）
  const candidates: string[] = []
  let entries
  try {
    entries = await readdir(workDir, { withFileTypes: true })
  } catch {
    return []
  }
  const rootMd = entries
    .filter((e) => e.isFile() && /\.md$/i.test(e.name))
    .map((e) => join(workDir, e.name))
  if (rootMd.length > 0) {
    candidates.push(...rootMd)
  } else {
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
        else if (e.isFile() && /\.md$/i.test(e.name)) candidates.push(full)
      }
    }
    await walk(workDir)
  }

  // 读内容打分：只保留像分镜词的（靠结构特征，不靠文件名），按匹配度降序
  const scored: { path: string; score: number }[] = []
  for (const p of candidates) {
    let text = ''
    try {
      text = await readFile(p, 'utf8')
    } catch {
      continue
    }
    const s = storyboardScore(text)
    if (s >= 3) scored.push({ path: p, score: s })
  }
  scored.sort((a, b) => b.score - a.score)
  return scored.map((x) => x.path)
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

// ---- 辅助：输出文件名 ----
export function shotFileName(index: number): string {
  return `shot_${String(index).padStart(3, '0')}.mp4`
}
