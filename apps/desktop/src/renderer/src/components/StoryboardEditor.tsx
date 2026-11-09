import { useCallback, useState } from 'react'
import type { AuthUser } from '../hooks/useAuth'
import type { StoryboardParseResult, StoryboardShot, GenerateRequest } from '../../../preload'
import { getSupabaseConfig, getAuthService } from '../auth/service'
import { IconSparkles } from './icons'

interface StoryboardEditorProps {
  user: AuthUser
  onToast?: (msg: string) => void
}

type ShotStatus = 'pending' | 'running' | 'done' | 'error'

/** 组装 runGenerate 需要的输入（复用桌面端登录态 + Supabase 上下文） */
async function buildGen(user: AuthUser, shot: StoryboardShot): Promise<GenerateRequest | null> {
  const cfg = getSupabaseConfig()
  const auth = getAuthService()
  if (!cfg || !auth) return null
  const s = await auth.getSession()
  if (!s?.access_token) return null
  return {
    supabaseUrl: cfg.url,
    supabaseAnonKey: cfg.anonKey,
    accessToken: s.access_token,
    refreshToken: s.refresh_token,
    userId: user.id,
    prompt: shot.prompt,
    providerId: 'doubao',
    durationSec: shot.durationSec,
    mode: shot.images.length > 0 ? 'img2video' : 'text2video',
    images: shot.images,
    audio: 'on',
    ratio: '16:9'
  }
}

export default function StoryboardEditor({ user, onToast }: StoryboardEditorProps) {
  const [workDir, setWorkDir] = useState('')
  const [result, setResult] = useState<StoryboardParseResult | null>(null)
  const [statusMap, setStatusMap] = useState<Record<number, ShotStatus>>({})
  const [videos, setVideos] = useState<Record<number, string>>({})
  const [generating, setGenerating] = useState(false)
  const [finalVideo, setFinalVideo] = useState<string | null>(null)
  const [merging, setMerging] = useState(false)

  const pickDir = useCallback(async () => {
    const r = await window.api.storyboard.pickDir()
    if (!r.canceled && r.dir) {
      setWorkDir(r.dir)
      setResult(null)
      setVideos({})
      setStatusMap({})
      setFinalVideo(null)
    }
  }, [])

  const parse = useCallback(async () => {
    if (!workDir) return
    const r = await window.api.storyboard.parse({ workDir })
    if (r.ok && r.result) {
      setResult(r.result)
      const m: Record<number, ShotStatus> = {}
      r.result.shots.forEach((s) => { m[s.index] = 'pending' })
      setStatusMap(m)
      onToast?.(`解析完成：${r.result.shots.length} 段分镜`)
    } else {
      onToast?.(r.error || '解析失败')
    }
  }, [workDir, onToast])

  const generateOne = useCallback(
    async (shot: StoryboardShot) => {
      if (!result) return
      setStatusMap((m) => ({ ...m, [shot.index]: 'running' as ShotStatus }))
      try {
        const gen = await buildGen(user, shot)
        if (!gen) {
          onToast?.('未获取到登录态')
          setStatusMap((m) => ({ ...m, [shot.index]: 'error' as ShotStatus }))
          return
        }
        const r = await window.api.storyboard.generate({
          gen,
          batchDir: result.batchDir,
          index: shot.index
        })
        if (r.ok && r.videoPath) {
          setVideos((v) => ({ ...v, [shot.index]: r.videoPath! }))
          setStatusMap((m) => ({ ...m, [shot.index]: 'done' as ShotStatus }))
        } else {
          onToast?.(`分镜 ${shot.index} 失败：${r.error || '未知'}`)
          setStatusMap((m) => ({ ...m, [shot.index]: 'error' as ShotStatus }))
        }
      } catch (e) {
        onToast?.(`分镜 ${shot.index} 异常：${e instanceof Error ? e.message : String(e)}`)
        setStatusMap((m) => ({ ...m, [shot.index]: 'error' as ShotStatus }))
      }
    },
    [result, user, onToast]
  )

  const generateAll = useCallback(async () => {
    if (!result || generating) return
    setGenerating(true)
    // 串行生成，避免 WebView 并发冲突
    for (const shot of result.shots) {
      await generateOne(shot)
    }
    setGenerating(false)
  }, [result, generating, generateOne])

  const merge = useCallback(async () => {
    if (!result || merging) return
    setMerging(true)
    try {
      const r = await window.api.storyboard.merge({ batchDir: result.batchDir })
      if (r.ok && r.output) {
        setFinalVideo(r.output)
        onToast?.('合并完成')
      } else {
        onToast?.(r.error || '合并失败')
      }
    } finally {
      setMerging(false)
    }
  }, [result, merging, onToast])

  const doneCount = Object.values(statusMap).filter((s) => s === 'done').length
  const total = result?.shots.length ?? 0

  return (
    <div className="storyboard-editor">
      <div className="storyboard-toolbar">
        <button className="btn" onClick={pickDir}>
          1. 选择工作目录
        </button>
        <button className="btn" onClick={parse} disabled={!workDir}>
          2. 解析分镜词 + 匹配资源
        </button>
        <button className="btn btn-primary" onClick={generateAll} disabled={!result || generating}>
          {generating ? `生成中 ${doneCount}/${total}` : '3. 生成全部片段'}
        </button>
        <button className="btn" onClick={merge} disabled={doneCount === 0 || merging}>
          {merging ? '合并中…' : '4. 合并成片'}
        </button>
      </div>

      <div className="storyboard-meta">
        {workDir && <span>工作目录：{workDir}</span>}
        {result && <span>｜分镜文本：{result.textPath}</span>}
        {result && <span>｜共 {total} 段</span>}
        {result && <span>｜完成 {doneCount}</span>}
      </div>

      {finalVideo && (
        <div className="storyboard-final">
          <h3>成片</h3>
          <video src={`file://${finalVideo}`} controls className="storyboard-video" />
          <div className="storyboard-path">路径：{finalVideo}</div>
        </div>
      )}

      {result && (
        <div className="storyboard-shots">
          {result.shots.map((shot) => {
            const st = statusMap[shot.index] || 'pending'
            return (
              <div key={shot.index} className={`storyboard-shot status-${st}`}>
                <div className="shot-head">
                  <span className="shot-index">{shot.index}</span>
                  <span className="shot-id">{shot.id}</span>
                  <span className="shot-title">{shot.title}</span>
                  <span className="shot-dur">{shot.durationSec}s</span>
                  <button
                    className="btn btn-sm"
                    onClick={() => generateOne(shot)}
                    disabled={st === 'running' || generating}
                  >
                    {st === 'done' ? '重生成' : st === 'running' ? '生成中…' : '生成'}
                  </button>
                  <span className={`shot-status status-${st}`}>
                    {st === 'done' ? '✓' : st === 'running' ? '…' : st === 'error' ? '✗' : '待'}
                  </span>
                </div>

                {shot.images.length > 0 && (
                  <div className="shot-images">
                    {shot.images.slice(0, 6).map((img, i) => (
                      <img key={i} src={`file://${img}`} alt={shot.refs[i] || ''} className="shot-thumb" />
                    ))}
                    {shot.images.length > 6 && <span className="more">+{shot.images.length - 6}</span>}
                  </div>
                )}

                <details className="shot-prompt">
                  <summary>提示词（raw 照抄）</summary>
                  <pre>{shot.prompt}</pre>
                </details>

                {shot.dialogue.length > 0 && (
                  <div className="shot-dialogue">
                    {shot.dialogue.map((d, i) => (
                      <span key={i} className="dialogue-line">{d.role}: {d.line}</span>
                    ))}
                  </div>
                )}

                {videos[shot.index] && (
                  <video src={`file://${videos[shot.index]}`} controls className="shot-video" />
                )}
              </div>
            )
          })}
        </div>
      )}

      {!result && (
        <div className="storyboard-empty">
          <IconSparkles size={32} />
          <p>选择一个包含分镜文本（.md）和资源图片的工作目录，开始分镜编排。</p>
          <p className="hint">分镜词默认 raw 照抄（不做语义转换），程序自动匹配 @引用 到资源图片。</p>
        </div>
      )}
    </div>
  )
}
