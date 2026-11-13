import { useCallback, useMemo, useState } from 'react'
import type { AuthUser } from '../hooks/useAuth'
import type { StoryboardParseResult, StoryboardShot, GenerateRequest } from '../../../preload'
import { getSupabaseConfig, getAuthService } from '../auth/service'
import type { ProvidersResult } from '../hooks/useProviders'
import Select from './Select'
import { IconSparkles } from './icons'
import { getInitialShowWebview } from './Modals'
import { initializePromptDrafts, promptForGeneration, updatePromptDraft } from './storyboard-prompt-policy'

interface StoryboardEditorProps {
  user: AuthUser
  providers: ProvidersResult
  onToast?: (msg: string) => void
}

type ShotStatus = 'pending' | 'running' | 'done' | 'error'
const BATCH_GENERATION_ENABLED = false

/** 组装 runGenerate 需要的输入（复用桌面端登录态 + Supabase 上下文） */
async function buildGen(user: AuthUser, shot: StoryboardShot, preferredAccountId?: string | null, opts?: { autoConfirm?: boolean }): Promise<GenerateRequest | null> {
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
    ratio: '16:9',
    showWebview: getInitialShowWebview(),
    preferredAccountId: preferredAccountId || null,
    autoConfirm: opts?.autoConfirm || false
  }
}

export default function StoryboardEditor({ user, providers, onToast }: StoryboardEditorProps) {
  const [workDir, setWorkDir] = useState('')
  const [result, setResult] = useState<StoryboardParseResult | null>(null)
  const [statusMap, setStatusMap] = useState<Record<number, ShotStatus>>({})
  const [videos, setVideos] = useState<Record<number, string>>({})
  const [generating, setGenerating] = useState(false)
  const [activeShotIndex, setActiveShotIndex] = useState<number | null>(null)
  const [finalVideo, setFinalVideo] = useState<string | null>(null)
  const [merging, setMerging] = useState(false)
  const [confirmRegen, setConfirmRegen] = useState<number | null>(null)
  const [retryInfo, setRetryInfo] = useState<Record<number, { jobId: string; remoteUrl: string }>>({})
  const [openInfo, setOpenInfo] = useState<Record<number, string>>({})
  const [openedPage, setOpenedPage] = useState<number | null>(null)
  const [preferredAccountId, setPreferredAccountId] = useState('')
  const [manualUrlFor, setManualUrlFor] = useState<number | null>(null)
  const [manualUrlValue, setManualUrlValue] = useState('')
  const [videoPickerFor, setVideoPickerFor] = useState<number | null>(null)
  const [videoPickerList, setVideoPickerList] = useState<Array<{ src: string; poster?: string }>>([])
  const [promptDrafts, setPromptDrafts] = useState<Record<number, string>>({})

  const doubaoKeys = useMemo(() => providers.aggs.find((a) => a.providerId === 'doubao')?.bindings ?? [], [providers.aggs])

  const pickDir = useCallback(async () => {
    const r = await window.api.storyboard.pickDir()
    if (!r.canceled && r.dir) {
      setWorkDir(r.dir)
      setResult(null)
      setVideos({})
      setStatusMap({})
      setPromptDrafts({})
      setFinalVideo(null)
    }
  }, [])

  const parse = useCallback(async () => {
    if (!workDir) return
    const r = await window.api.storyboard.parse({ workDir })
    if (r.ok && r.result) {
      setResult(r.result)
      setPromptDrafts(initializePromptDrafts(r.result.shots))
      const m: Record<number, ShotStatus> = {}
      const v: Record<number, string> = {}
      const ri: Record<number, { jobId: string; remoteUrl: string }> = {}
      const oi: Record<number, string> = {}
      r.result.shots.forEach((s) => { m[s.index] = 'pending' })
      // 恢复进度：已生成的关联视频、有 remoteUrl 的标记可补下载、有 accountId 的标记可打开豆包
      const progress = r.result.progress || {}
      Object.entries(progress).forEach(([idxStr, p]) => {
        const idx = Number(idxStr)
        if (p.videoPath) {
          v[idx] = p.videoPath
          m[idx] = 'done'
        } else {
          // 文件丢失：同时提供「补下载」（有 remoteUrl+jobId）和「打开豆包」（有 accountId）两个兜底
          if (p.remoteUrl && p.jobId) {
            ri[idx] = { jobId: p.jobId, remoteUrl: p.remoteUrl }
          }
          if (p.accountId) {
            oi[idx] = p.accountId
          }
          m[idx] = 'error'
        }
      })
      setVideos(v)
      setRetryInfo(ri)
      setOpenInfo(oi)
      setStatusMap(m)
      onToast?.(`解析完成：${r.result.shots.length} 段分镜`)
    } else {
      onToast?.(r.error || '解析失败')
    }
  }, [workDir, onToast])

  const generateOne = useCallback(
    async (shot: StoryboardShot, opts?: { isBatch?: boolean }) => {
      const isBatch = opts?.isBatch === true
      if (!result || activeShotIndex !== null) return
      setActiveShotIndex(shot.index)
      // 新一轮生成开始前清除该分镜上一次失败留下的账号/补下载信息，避免本次未知失败误用旧现场。
      setOpenInfo((m) => {
        const next = { ...m }
        delete next[shot.index]
        return next
      })
      setRetryInfo((m) => {
        const next = { ...m }
        delete next[shot.index]
        return next
      })
      setOpenedPage((current) => current === shot.index ? null : current)
      setVideos((m) => {
        const next = { ...m }
        delete next[shot.index]
        return next
      })
      setStatusMap((m) => ({ ...m, [shot.index]: 'running' as ShotStatus }))
      try {
        const begun = await window.api.storyboard.beginGenerate({ batchDir: result.batchDir, index: shot.index })
        if (!begun.ok) throw new Error(begun.error || '无法清理上一轮分镜进度')
        const currentShot = { ...shot, prompt: promptForGeneration(shot, promptDrafts) }
        const gen = await buildGen(user, currentShot, preferredAccountId || null, { autoConfirm: isBatch })
        if (!gen) {
          const failed = await window.api.storyboard.markError({ batchDir: result.batchDir, index: shot.index })
          onToast?.(failed.ok ? '未获取到登录态' : `未获取到登录态；进度写入失败：${failed.error || '未知错误'}`)
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
          if (r.jobId && r.remoteUrl) {
            setRetryInfo((m) => ({ ...m, [shot.index]: { jobId: r.jobId!, remoteUrl: r.remoteUrl! } }))
          }
          if (r.accountId) setOpenInfo((m) => ({ ...m, [shot.index]: r.accountId! }))
          onToast?.(`分镜 ${shot.index} 失败：${r.error || '未知'}`)
          setStatusMap((m) => ({ ...m, [shot.index]: 'error' as ShotStatus }))
        }
      } catch (e) {
        const error = e instanceof Error ? e.message : String(e)
        const failed = await window.api.storyboard.markError({ batchDir: result.batchDir, index: shot.index }).catch((markError) => ({ ok: false, error: markError instanceof Error ? markError.message : String(markError) }))
        onToast?.(failed.ok
          ? `分镜 ${shot.index} 异常：${error}`
          : `分镜 ${shot.index} 异常：${error}；进度写入失败：${failed.error || '未知错误'}`)
        setStatusMap((m) => ({ ...m, [shot.index]: 'error' as ShotStatus }))
      } finally {
        setActiveShotIndex(null)
      }
    },
    [result, user, onToast, preferredAccountId, activeShotIndex, promptDrafts]
  )

  const retryDownload = useCallback(
    async (shot: StoryboardShot) => {
      if (!result) return
      const info = retryInfo[shot.index]
      if (!info) return
      setStatusMap((m) => ({ ...m, [shot.index]: 'running' as ShotStatus }))
      try {
        const cfg = getSupabaseConfig()
        const auth = getAuthService()
        const session = await auth?.getSession()
        if (!cfg || !session?.access_token) throw new Error('登录状态异常，无法补下载并结算额度')
        const r = await window.api.storyboard.reDownload({
          remoteUrl: info.remoteUrl,
          jobId: info.jobId,
          batchDir: result.batchDir,
          index: shot.index,
          supabaseUrl: cfg.url,
          supabaseAnonKey: cfg.anonKey,
          accessToken: session.access_token,
          refreshToken: session.refresh_token,
          userId: user.id
        })
        if (r.ok && r.videoPath) {
          setVideos((v) => ({ ...v, [shot.index]: r.videoPath! }))
          setStatusMap((m) => ({ ...m, [shot.index]: 'done' as ShotStatus }))
          setRetryInfo((m) => {
            const n = { ...m }
            delete n[shot.index]
            return n
          })
        } else {
          onToast?.(`补下载失败：${r.error || '未知'}`)
          setStatusMap((m) => ({ ...m, [shot.index]: 'error' as ShotStatus }))
        }
      } catch (e) {
        onToast?.(`补下载异常：${e instanceof Error ? e.message : String(e)}`)
        setStatusMap((m) => ({ ...m, [shot.index]: 'error' as ShotStatus }))
      }
    },
    [result, retryInfo, onToast, user]
  )

  const openDoubao = useCallback(
    async (shot: StoryboardShot) => {
      const keyId = openInfo[shot.index]
      const r = await window.api.storyboard.openDoubaoPage({ keyId })
      if (!r.ok) onToast?.(`打开豆包失败：${r.error || '未知'}`)
      else setOpenedPage(shot.index)
    },
    [openInfo, onToast]
  )

  const downloadLatest = useCallback(
    async (shot: StoryboardShot) => {
      if (!result) return
      const keyId = openInfo[shot.index]
      setStatusMap((m) => ({ ...m, [shot.index]: 'running' as ShotStatus }))
      try {
        const r = await window.api.storyboard.downloadLatest({ keyId, batchDir: result.batchDir, index: shot.index })
        if (r.ok && r.videoPath) {
          setVideos((v) => ({ ...v, [shot.index]: r.videoPath! }))
          setStatusMap((m) => ({ ...m, [shot.index]: 'done' as ShotStatus }))
          onToast?.(`分镜 ${shot.index} 已下载`)
        } else {
          onToast?.(`下载最新失败：${r.error || '未知'}`)
          setStatusMap((m) => ({ ...m, [shot.index]: 'error' as ShotStatus }))
        }
      } catch (e) {
        onToast?.(`下载最新异常：${e instanceof Error ? e.message : String(e)}`)
        setStatusMap((m) => ({ ...m, [shot.index]: 'error' as ShotStatus }))
      }
    },
    [result, openInfo, onToast]
  )

  const manualDownload = useCallback(
    async (shot: StoryboardShot) => {
      if (!result) return
      const url = manualUrlValue.trim()
      if (!url) {
        onToast?.('请先填写视频 URL')
        return
      }
      setStatusMap((m) => ({ ...m, [shot.index]: 'running' as ShotStatus }))
      try {
        const r = await window.api.storyboard.manualDownload({ url, batchDir: result.batchDir, index: shot.index })
        if (r.ok && r.videoPath) {
          setVideos((v) => ({ ...v, [shot.index]: r.videoPath! }))
          setStatusMap((m) => ({ ...m, [shot.index]: 'done' as ShotStatus }))
          setManualUrlFor(null)
          setManualUrlValue('')
          onToast?.(`分镜 ${shot.index} 已从 URL 下载`)
        } else {
          onToast?.(`手动下载失败：${r.error || '未知'}`)
          setStatusMap((m) => ({ ...m, [shot.index]: 'error' as ShotStatus }))
        }
      } catch (e) {
        onToast?.(`手动下载异常：${e instanceof Error ? e.message : String(e)}`)
        setStatusMap((m) => ({ ...m, [shot.index]: 'error' as ShotStatus }))
      }
    },
    [result, manualUrlValue, onToast]
  )

  const pickVideo = useCallback(
    async (shot: StoryboardShot) => {
      const keyId = openInfo[shot.index]
      const r = await window.api.storyboard.listVideos({ keyId })
      if (!r.ok || !r.videos || r.videos.length === 0) {
        onToast?.(r.error || '未提取到视频')
        return
      }
      setVideoPickerList(r.videos)
      setVideoPickerFor(shot.index)
    },
    [openInfo, onToast]
  )

  const downloadPickedVideo = useCallback(
    async (shot: StoryboardShot, url: string) => {
      if (!result) return
      setVideoPickerFor(null)
      setVideoPickerList([])
      setStatusMap((m) => ({ ...m, [shot.index]: 'running' as ShotStatus }))
      try {
        const r = await window.api.storyboard.manualDownload({ url, batchDir: result.batchDir, index: shot.index })
        if (r.ok && r.videoPath) {
          setVideos((v) => ({ ...v, [shot.index]: r.videoPath! }))
          setStatusMap((m) => ({ ...m, [shot.index]: 'done' as ShotStatus }))
          onToast?.(`分镜 ${shot.index} 已下载所选视频`)
        } else {
          onToast?.(`下载失败：${r.error || '未知'}`)
          setStatusMap((m) => ({ ...m, [shot.index]: 'error' as ShotStatus }))
        }
      } catch (e) {
        onToast?.(`下载异常：${e instanceof Error ? e.message : String(e)}`)
        setStatusMap((m) => ({ ...m, [shot.index]: 'error' as ShotStatus }))
      }
    },
    [result, onToast]
  )

  const generateAll = useCallback(async () => {
    if (!result || generating) return
    setGenerating(true)
    // 串行生成，避免 WebView 并发冲突
    for (const shot of result.shots) {
      await generateOne(shot, { isBatch: true })
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
        <button className="btn btn-primary" onClick={pickDir}>
          1. 选择工作目录
        </button>
        <span className="step-arrow" aria-hidden="true">→</span>
        <button className="btn btn-primary" onClick={parse} disabled={!workDir}>
          2. 解析分镜词 + 匹配资源
        </button>
        <span className="step-arrow" aria-hidden="true">→</span>
        <button className="btn btn-primary" onClick={merge} disabled={doneCount === 0 || merging}>
          {merging ? '合并中…' : '3. 合并成片'}
        </button>
        <span className="step-divider" aria-hidden="true" />
        <Select
          value={preferredAccountId}
          onChange={setPreferredAccountId}
          options={[
            { value: '', label: '账号：自动' },
            ...doubaoKeys.map((k) => ({
              value: k.keyId,
              label: `${k.accountName}（剩 ${k.remaining}秒）${k.health === 'expired' ? '｜已失效' : k.health === 'expiring' ? '｜即将过期' : ''}`,
              disabled: k.health === 'expired'
            }))
          ]}
          style={{ minWidth: 210 }}
        />
        <button
          className="btn"
          onClick={generateAll}
          disabled={!BATCH_GENERATION_ENABLED || !result || generating}
          title="批量生成逻辑已保留，待普通逐段流程实机验收通过后开放"
        >
          {generating ? `批量生成中 ${doneCount}/${total}` : '批量生成（暂未开放）'}
        </button>
      </div>

      <div className="storyboard-meta">
        {workDir && <span>工作目录：{workDir}</span>}
        {result && <span>｜分镜文本：{result.textPath}</span>}
        {result && <span>｜共 {total} 段</span>}
        {result && <span>｜完成 {doneCount}</span>}
      </div>

      {result && (
        <div className="storyboard-hint">
          当前仅开放逐段生成：审核下方分镜词与匹配资源后，点击每段的「生成」。批量逻辑继续维护并记录进度，待普通流程实机验收通过后开放入口。
        </div>
      )}

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
                    className="btn btn-sm btn-primary"
                    onClick={() => {
                      if (st === 'done' && confirmRegen !== shot.index) {
                        setConfirmRegen(shot.index)
                        return
                      }
                      setConfirmRegen(null)
                      void generateOne(shot)
                    }}
                    disabled={st === 'running' || generating || activeShotIndex !== null}
                  >
                    {st === 'done'
                      ? confirmRegen === shot.index
                        ? '确认重生成？'
                        : '✓ 重生成'
                      : st === 'running'
                        ? '生成中…'
                        : '生成'}
                  </button>
                  <span className={`shot-status status-${st}`}>
                    {st === 'done' ? '✓' : st === 'running' ? '…' : st === 'error' ? '✗' : '待'}
                  </span>
                  {st === 'error' && retryInfo[shot.index] && (
                    <button className="btn btn-sm" onClick={() => void retryDownload(shot)} disabled={generating}>
                      补下载
                    </button>
                  )}
                  {st === 'error' && openInfo[shot.index] && (
                    <button className="btn btn-sm" onClick={() => void openDoubao(shot)} disabled={generating}>
                      打开豆包
                    </button>
                  )}
                  {st === 'error' && openedPage === shot.index && (
                    <button className="btn btn-sm" onClick={() => void downloadLatest(shot)} disabled={generating}>
                      下载最新
                    </button>
                  )}
                  {st === 'error' && openedPage === shot.index && (
                    <button className="btn btn-sm" onClick={() => void pickVideo(shot)} disabled={generating}>
                      选视频
                    </button>
                  )}
                  {st === 'error' && (
                    <button
                      className="btn btn-sm"
                      onClick={() => {
                        setManualUrlFor(shot.index)
                        setManualUrlValue('')
                      }}
                      disabled={generating}
                    >
                      手动填 URL
                    </button>
                  )}
                </div>

                {manualUrlFor === shot.index && (
                  <div className="shot-manual-url">
                    <input
                      type="text"
                      value={manualUrlValue}
                      onChange={(e) => setManualUrlValue(e.target.value)}
                      placeholder="粘贴视频 URL（http/https）"
                    />
                    <button className="btn btn-sm btn-primary" onClick={() => void manualDownload(shot)} disabled={generating}>
                      下载
                    </button>
                    <button
                      className="btn btn-sm"
                      onClick={() => {
                        setManualUrlFor(null)
                        setManualUrlValue('')
                      }}
                    >
                      取消
                    </button>
                  </div>
                )}

                {videoPickerFor === shot.index && (
                  <div className="shot-video-picker">
                    <div className="picker-title">选择要下载的视频（从旧到新）：</div>
                    <div className="picker-list">
                      {videoPickerList.map((v, i) => (
                        <div key={i} className="picker-item" onClick={() => void downloadPickedVideo(shot, v.src)}>
                          {v.poster ? <img src={v.poster} className="picker-thumb" alt="" /> : <span className="picker-nothumb">无封面</span>}
                          <span className="picker-index">第 {i + 1} 个</span>
                        </div>
                      ))}
                    </div>
                    <button
                      className="btn btn-sm"
                      onClick={() => {
                        setVideoPickerFor(null)
                        setVideoPickerList([])
                      }}
                    >
                      取消
                    </button>
                  </div>
                )}

                {shot.images.length > 0 && (
                  <div className="shot-images">
                    {shot.images.slice(0, 6).map((img, i) => (
                      <img key={i} src={`file://${img}`} alt={shot.refs[i] || ''} className="shot-thumb" />
                    ))}
                    {shot.images.length > 6 && <span className="more">+{shot.images.length - 6}</span>}
                  </div>
                )}

                <details className="shot-prompt" open>
                  <summary>提示词（客户端可修改，不改来源文档）</summary>
                  <textarea
                    value={promptForGeneration(shot, promptDrafts)}
                    onChange={(e) => setPromptDrafts((drafts) => updatePromptDraft(drafts, shot.index, e.target.value))}
                    disabled={st === 'running'}
                    aria-label={`分镜 ${shot.index} 提示词`}
                  />
                </details>

                {shot.dialogue.length > 0 && (
                  <div className="shot-dialogue">
                    {shot.dialogue.map((d, i) => (
                      <span key={i} className="dialogue-line">{d.role}: {d.line}</span>
                    ))}
                  </div>
                )}

                {videos[shot.index] && (
                  <>
                    <video src={`file://${videos[shot.index]}`} controls className="shot-video" />
                    <div className="shot-video-path">
                      <span className="path-text" title={videos[shot.index]}>{videos[shot.index]}</span>
                      <button
                        className="btn btn-sm"
                        onClick={() => void window.api.media.showInFolder(videos[shot.index], workDir)}
                      >
                        打开所在文件夹
                      </button>
                    </div>
                  </>
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
