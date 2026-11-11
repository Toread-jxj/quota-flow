import { app, BrowserWindow, dialog, ipcMain, safeStorage, shell } from 'electron'
import { copyFileSync, createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join, resolve } from 'node:path'
import type { AddressInfo } from 'node:net'
import { initWebviewTest } from './webview-test'
import { initProviders } from './providers'
import { registerApiIpc } from './api-branch'
import { initCookieRenew } from './cookie-renew'
import {
  checkForUpdatesNow,
  downloadUpdate,
  initAutoUpdater,
  quitAndInstall as quitAndInstallUpdater
} from './updater'
import { runGenerate, downloadVideo } from './dispatch'
import type { DispatchEvent, QuotaUpdatedPayload } from './dispatch'
import { initApiServer, setApiContext } from './api-server'
import { parseStoryboardText, matchAssets, mergeVideos, shotFileName, findStoryboardFiles } from './storyboard'
import { openDoubaoPage, extractLatestDoubaoVideoUrl, autoRetryExtractDoubaoVideo, extractAllDoubaoVideos } from './webview-engine'
import type { ApiContext } from './api-server'
import type { UpdaterStatus } from './updater'
import { getWatermarkStatus, processWatermarkJob } from './watermark-remover/job'
import type { WatermarkJobInput } from './watermark-remover/job'
import type { WatermarkProgress } from './watermark-remover/engine'
import { getMaterialStore } from './materials/store'
import { uploadImage as uploadImageToGh, cleanupOldImages } from './github-upload'
import { clearKeysCache, handleKeysCacheInvalidate } from './query-cache'
import { generationLogPath, logGeneration } from './diagnostics'

/** 活跃生成任务注册表：jobId → 取消/已提交状态（用于「终止生成」与「关闭确认」） */
interface ActiveRunState {
  aborted: boolean
  submitted: boolean
}
const activeRuns = new Map<string, ActiveRunState>()
const activeWatermarkAborters = new Map<string, AbortController>()
let allowClose = false
/** 是否有生成在跑（含任务注册前的准备窗口） */
let isGenerating = false
/** 任务注册前用户已点停止 → 注册后立即置 aborted */
let pendingCancel = false
/** 最近一次生成的 Supabase 上下文：优雅关闭时把运行中任务改写为 failed（等下次启动 reconcile 兜底） */
let lastDispatchCtx: { supabaseUrl: string; supabaseAnonKey: string; userId: string } | null = null
import { createSupabaseClient, JobService, ProviderService, todayKey } from '@quota-flow/db-supabase'

// 本地媒体预览服务：127.0.0.1 随机端口
//  - 根路径：userData/videos 下 <uuid>.mp4（视频，支持 Range）
//  - /images/：userData/images 下 <jobId>-<n>.<ext>（图生视频上传的图片副本）
let mediaPortPromise: Promise<number> | null = null

function sendUpdaterStatus(status: UpdaterStatus): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.webContents.isDestroyed()) {
      win.webContents.send('updater:status', status)
    }
  }
}

function sendQuotaUpdated(payload: QuotaUpdatedPayload): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.webContents.isDestroyed()) {
      win.webContents.send('quota:updated', payload)
    }
  }
}

function startMediaServer(): Promise<number> {
  if (!mediaPortPromise) {
    mediaPortPromise = new Promise((resolve, reject) => {
      const videosDir = join(app.getPath('userData'), 'videos')
      const imagesDir = join(app.getPath('userData'), 'images')
      const materialsDir = join(app.getPath('userData'), 'materials')
      const imageContentType = (ext: string): string =>
        ext === 'png' ? 'image/png' : ext === 'gif' ? 'image/gif' : ext === 'webp' ? 'image/webp' : 'image/jpeg'
      const serveImage = (res: import('node:http').ServerResponse, name: string, dir: string): void => {
        const file = join(dir, name)
        if (!existsSync(file)) {
          res.writeHead(404)
          res.end()
          return
        }
        const ext = (name.split('.').pop() || 'jpg').toLowerCase()
        res.writeHead(200, { 'Content-Type': imageContentType(ext), 'Cache-Control': 'no-store' })
        createReadStream(file).pipe(res)
      }
      const server = createServer((req, res) => {
        const path = (req.url || '').split('?')[0]
        // 参考生（r2v）参考视频副本：userData/videos/<jobId>-<i>.mp4，Range 支持
        const serveVideo = (file: string): void => {
          if (!existsSync(file)) {
            res.writeHead(404)
            res.end()
            return
          }
          const size = statSync(file).size
          res.setHeader('Content-Type', 'video/mp4')
          res.setHeader('Accept-Ranges', 'bytes')
          const range = req.headers.range
          if (range) {
            const m = /bytes=(\d*)-(\d*)/.exec(range)
            const start = m && m[1] ? parseInt(m[1], 10) : 0
            const end = m && m[2] ? parseInt(m[2], 10) : size - 1
            res.writeHead(206, {
              'Content-Range': `bytes ${start}-${end}/${size}`,
              'Content-Length': end - start + 1
            })
            createReadStream(file, { start, end }).pipe(res)
          } else {
            res.writeHead(200, { 'Content-Length': size })
            createReadStream(file).pipe(res)
          }
        }
        if (path.startsWith('/ref-videos/')) {
          const name = path.slice('/ref-videos/'.length)
          if (!/^[0-9a-fA-F-]+-\d+\.mp4$/.test(name)) {
            res.writeHead(400)
            res.end()
            return
          }
          serveVideo(join(videosDir, name))
          return
        }
        if (path.startsWith('/images/')) {
          const name = path.slice('/images/'.length)
          if (!/^[0-9a-fA-F-]+-\d+\.(png|jpe?g|gif|webp)$/i.test(name)) {
            res.writeHead(400)
            res.end()
            return
          }
          serveImage(res, name, imagesDir)
          return
        }
        if (path.startsWith('/materials/')) {
          const name = path.slice('/materials/'.length)
          if (!/^[0-9a-fA-F-]+\.(png|jpe?g|gif|webp|mp4)$/i.test(name)) {
            res.writeHead(400)
            res.end()
            return
          }
          const file = join(materialsDir, name)
          if (!existsSync(file)) {
            res.writeHead(404)
            res.end()
            return
          }
          const ext = (name.split('.').pop() || '').toLowerCase()
          if (ext === 'mp4') {
            const size = statSync(file).size
            res.setHeader('Content-Type', 'video/mp4')
            res.setHeader('Accept-Ranges', 'bytes')
            const range = req.headers.range
            if (range) {
              const m = /bytes=(\d*)-(\d*)/.exec(range)
              const start = m && m[1] ? parseInt(m[1], 10) : 0
              const end = m && m[2] ? parseInt(m[2], 10) : size - 1
              res.writeHead(206, {
                'Content-Range': `bytes ${start}-${end}/${size}`,
                'Content-Length': end - start + 1
              })
              createReadStream(file, { start, end }).pipe(res)
            } else {
              res.writeHead(200, { 'Content-Length': size })
              createReadStream(file).pipe(res)
            }
          } else {
            serveImage(res, name, materialsDir)
          }
          return
        }
        const name = path.replace(/^\//, '')
        if (!/^[0-9a-fA-F-]+(\.clean(?:-[A-Za-z0-9-]+)?)?\.mp4$/.test(name)) {
          res.writeHead(400)
          res.end()
          return
        }
        const file = join(videosDir, name)
        if (!existsSync(file)) {
          res.writeHead(404)
          res.end()
          return
        }
        const size = statSync(file).size
        res.setHeader('Content-Type', 'video/mp4')
        res.setHeader('Accept-Ranges', 'bytes')
        const range = req.headers.range
        if (range) {
          const m = /bytes=(\d*)-(\d*)/.exec(range)
          const start = m && m[1] ? parseInt(m[1], 10) : 0
          const end = m && m[2] ? parseInt(m[2], 10) : size - 1
          res.writeHead(206, {
            'Content-Range': `bytes ${start}-${end}/${size}`,
            'Content-Length': end - start + 1
          })
          createReadStream(file, { start, end }).pipe(res)
        } else {
          res.writeHead(200, { 'Content-Length': size })
          createReadStream(file).pipe(res)
        }
      })
      server.on('error', reject)
      server.listen(0, '127.0.0.1', () => {
        resolve((server.address() as AddressInfo).port)
      })
    })
  }
  return mediaPortPromise
}

interface StoredSession {
  accessToken: string
  refreshToken: string
  expiresAt: number
}

function sessionFilePath(): string {
  return join(app.getPath('userData'), 'auth.json')
}

function readStoredSession(): StoredSession | null {
  try {
    const file = sessionFilePath()
    if (!existsSync(file) || !safeStorage.isEncryptionAvailable()) return null
    const json = safeStorage.decryptString(
      Buffer.from(readFileSync(file, 'utf8'), 'base64')
    )
    const session = JSON.parse(json) as StoredSession
    if (typeof session.accessToken !== 'string' || typeof session.refreshToken !== 'string') {
      return null
    }
    return session
  } catch {
    return null
  }
}

function writeStoredSession(session: StoredSession): void {
  if (!safeStorage.isEncryptionAvailable()) return
  mkdirSync(app.getPath('userData'), { recursive: true })
  const encrypted = safeStorage.encryptString(JSON.stringify(session))
  writeFileSync(sessionFilePath(), encrypted.toString('base64'), 'utf8')
}

function clearStoredSession(): void {
  try {
    rmSync(sessionFilePath(), { force: true })
  } catch {
    // ignore
  }
}

/**
 * 优雅关闭时把仍在运行的生成任务 best-effort 改写为 failed，
 * 这样无需等下次启动 reconcile，admin 端/下次查看即可看到「失败」而非「排队/生成中」。
 * 写失败不阻断退出（服务端已接单的任务仍由下次启动 reconcile 兜底清扫）。
 */
async function markActiveRunsFailed(): Promise<void> {
  const ctx = lastDispatchCtx
  const jobs = [...activeRuns.keys()]
  if (!ctx || jobs.length === 0) return
  try {
    const session = readStoredSession()
    if (!session) return
    const client = createSupabaseClient({
      supabaseUrl: ctx.supabaseUrl,
      supabaseAnonKey: ctx.supabaseAnonKey
    })
    await client.auth.setSession({ access_token: session.accessToken, refresh_token: session.refreshToken })
    const jobSvc = new JobService(client)
    await Promise.all(
      jobs.map(async (jobId) => {
        try {
          await jobSvc.updateJob(ctx.userId, jobId, {
            status: 'failed',
            error: '应用已关闭，生成中断',
            completedAt: new Date().toISOString()
          })
        } catch {
          // 单条写失败不阻断，reconcile 下次启动兜底
        }
      })
    )
  } catch {
    // 会话/网络异常不阻断退出
  }
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 1120,
    minHeight: 700,
    show: false,
    frame: false,
    icon: join(__dirname, '../renderer/icon.png'),
    // 与页面默认 dark 主题背景一致（styles.css [data-theme="dark"] --bg-base: #0c0c0c），
    // 避免点击重绘时露出浅色背景导致整窗闪烁
    backgroundColor: '#0c0c0c',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  win.on('ready-to-show', () => win.show())
  win.on('maximize', () => win.webContents.send('window:maximize-changed', true))
  win.on('unmaximize', () => win.webContents.send('window:maximize-changed', false))
  // 生成进行中关闭 → 弹确认框，避免误关导致生成意外中断
  win.on('close', (e) => {
    if (allowClose || activeRuns.size === 0) return
    e.preventDefault()
    void dialog
      .showMessageBox(win, {
        type: 'warning',
        title: '视频正在生成',
        message: '当前有视频正在生成，关闭应用将中断生成。确定要关闭吗？',
        buttons: ['取消', '确认关闭'],
        defaultId: 0,
        cancelId: 0,
        noLink: true
      })
      .then(async ({ response }) => {
        if (response === 1) {
          await markActiveRunsFailed()
          allowClose = true
          win.close()
        }
      })
  })
  initWebviewTest(win)

  if (process.env['ELECTRON_RENDERER_URL']) {
    void win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  void startMediaServer()
  // 启动后兜底清理：移除 GitHub 图床 qf-images/ 下超过 24 小时的旧参考图（防止任务中断/失败残留累积撑大仓库）
  setTimeout(() => {
    void cleanupOldImages(24 * 60 * 60 * 1000).catch(() => {})
  }, 10_000)
  ipcMain.handle('media:get-url', async (_e, name: unknown) => {
    if (typeof name !== 'string' || !/^[0-9a-fA-F-]+(\.clean(?:-[A-Za-z0-9-]+)?)?\.mp4$/.test(name)) {
      throw new Error('invalid media name')
    }
    const port = await startMediaServer()
    return `http://127.0.0.1:${port}/${name}`
  })

  ipcMain.handle('media:get-image-url', async (_e, name: unknown) => {
    if (typeof name !== 'string' || !/^[0-9a-fA-F-]+-\d+\.(png|jpe?g|gif|webp)$/i.test(name)) {
      throw new Error('invalid image name')
    }
    const port = await startMediaServer()
    return `http://127.0.0.1:${port}/images/${name}`
  })

  ipcMain.handle('media:get-ref-video-url', async (_e, name: unknown) => {
    if (typeof name !== 'string' || !/^[0-9a-fA-F-]+-\d+\.mp4$/.test(name)) {
      throw new Error('invalid ref video name')
    }
    const port = await startMediaServer()
    return `http://127.0.0.1:${port}/ref-videos/${name}`
  })

  ipcMain.handle('media:show-in-folder', (_e, filePath: unknown, root?: unknown) => {
    if (typeof filePath !== 'string' || !filePath) throw new Error('invalid path')
    // 只允许打开 userData/videos、userData/storyboard 或指定 root（工作目录）下的文件，避免 renderer 被诱导打开任意路径
    const allowedDirs = [join(app.getPath('userData'), 'videos'), join(app.getPath('userData'), 'storyboard')]
    if (typeof root === 'string' && root) allowedDirs.push(root)
    const resolved = resolve(filePath)
    const target = resolved.toLowerCase()
    const inAllowed = allowedDirs.some((d) => {
      const dir = d.toLowerCase()
      return target === dir || target.startsWith(dir + '\\') || target.startsWith(dir + '/')
    })
    if (!inAllowed) throw new Error('path outside allowed directories')
    if (!existsSync(resolved)) return { ok: false, error: '文件不存在' }
    shell.showItemInFolder(resolved)
    return { ok: true }
  })

  ipcMain.handle('materials:list', async () => getMaterialStore().list())
  ipcMain.handle('materials:import', async (_e, paths: unknown) => {
    if (!Array.isArray(paths) || paths.some((p) => typeof p !== 'string')) {
      throw new Error('invalid material paths')
    }
    return getMaterialStore().importPaths(paths as string[])
  })
  ipcMain.handle('materials:remove', async (_e, id: unknown) => {
    if (typeof id !== 'string' || !id) throw new Error('invalid material id')
    return getMaterialStore().remove(id)
  })
  ipcMain.handle('materials:get-url', async (_e, fileName: unknown) => {
    if (typeof fileName !== 'string' || !/^[0-9a-fA-F-]+\.(png|jpe?g|gif|webp|mp4)$/.test(fileName)) {
      throw new Error('invalid material name')
    }
    const port = await startMediaServer()
    return `http://127.0.0.1:${port}/materials/${fileName}`
  })

  ipcMain.handle('ping', () => 'pong')

  // 主进程密钥分区缓存：渲染层写点（add/refresh/remove/默认/停用/改名/健康）成功后失效对应分区；
  // 登出/换账号时 clear 全清，保证「会话内先加载 + 重登录强制失效」语义。
  ipcMain.handle('keys-cache-invalidate', (_e, opts: unknown) => {
    const o = (opts ?? {}) as { keyId?: unknown; userId?: unknown; teamId?: unknown }
    handleKeysCacheInvalidate({
      keyId: typeof o.keyId === 'string' ? o.keyId : undefined,
      userId: typeof o.userId === 'string' ? o.userId : undefined,
      teamId: typeof o.teamId === 'string' ? o.teamId : undefined
    })
  })
  ipcMain.handle('keys-cache-clear', () => {
    clearKeysCache()
  })

  // 参考图上传到 GitHub 公开仓库并返回 jsDelivr CDN 公网 URL（密钥在主进程，渲染层仅传字节）
  ipcMain.handle('storage:upload-image', async (_e, payload: unknown) => {
    const p = (payload ?? {}) as { bytes?: ArrayBuffer; contentType?: string; ext?: string }
    if (!(p.bytes instanceof ArrayBuffer) || p.bytes.byteLength === 0) {
      throw new Error('非法的图片上传载荷')
    }
    const { url } = await uploadImageToGh({
      bytes: new Uint8Array(p.bytes),
      contentType: typeof p.contentType === 'string' ? p.contentType : '',
      ext: typeof p.ext === 'string' ? p.ext : 'png'
    })
    return { url }
  })
  // 参考图本地副本：写入 userData/images 供历史详情离线回显（与 dispatch 持久化语义一致）
  ipcMain.handle('storage:save-image-local', async (_e, payload: unknown) => {
    const p = (payload ?? {}) as { bytes?: ArrayBuffer; ext?: string }
    if (!(p.bytes instanceof ArrayBuffer) || p.bytes.byteLength === 0) {
      throw new Error('非法的图片载荷')
    }
    const ext = /^[a-z0-9]{1,8}$/.test((p.ext as string) || '') ? (p.ext as string) : 'png'
    const imgDir = join(app.getPath('userData'), 'images')
    mkdirSync(imgDir, { recursive: true })
    const name = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}.${ext}`
    const path = join(imgDir, name)
    writeFileSync(path, Buffer.from(p.bytes))
    return { path }
  })
  // 读取本地图片字节（历史「重新生成」时对 API 厂商重传参考图取新公网 URL 用）
  ipcMain.handle('storage:read-image-local', async (_e, path: unknown) => {
    if (typeof path !== 'string' || !path) {
      throw new Error('非法的图片路径')
    }
    const data = readFileSync(path)
    return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer
  })
  ipcMain.handle('window:minimize', (e) => BrowserWindow.fromWebContents(e.sender)?.minimize())
  ipcMain.handle('window:toggle-maximize', (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    if (!win) return
    if (win.isMaximized()) win.unmaximize()
    else win.maximize()
  })
  ipcMain.handle('window:close', (e) => BrowserWindow.fromWebContents(e.sender)?.close())
  ipcMain.handle('auth:get-session', () => readStoredSession())
  ipcMain.handle('auth:set-session', (_e, session: StoredSession) => {
    if (!session || typeof session.accessToken !== 'string' || typeof session.refreshToken !== 'string') {
      throw new Error('invalid session payload')
    }
    writeStoredSession({
      accessToken: session.accessToken,
      refreshToken: session.refreshToken,
      expiresAt: typeof session.expiresAt === 'number' ? session.expiresAt : 0
    })
  })
  ipcMain.handle('auth:clear-session', () => clearStoredSession())
  ipcMain.handle('updater:check', () => checkForUpdatesNow(sendUpdaterStatus))
  ipcMain.handle('updater:download', () => downloadUpdate(sendUpdaterStatus))
  ipcMain.handle('updater:quit-and-install', () => {
    quitAndInstallUpdater()
  })
  ipcMain.handle('dispatch:generate', async (e, input: Parameters<typeof runGenerate>[0]) => {
    const emit = (ev: DispatchEvent): void => {
      if (!e.sender.isDestroyed()) e.sender.send('job:event', ev)
    }
    const onQuotaUpdated = (payload: QuotaUpdatedPayload): void => {
      sendQuotaUpdated(payload)
    }
    let registeredJobId: string | null = null
    isGenerating = true
    pendingCancel = false
    lastDispatchCtx = { supabaseUrl: input.supabaseUrl, supabaseAnonKey: input.supabaseAnonKey, userId: input.userId }
    // 顺带把上下文缓存给 HTTP API server，外部系统即可通过 /v1/generate 复用同一登录态/账号
    setApiContext({
      supabaseUrl: input.supabaseUrl,
      supabaseAnonKey: input.supabaseAnonKey,
      accessToken: input.accessToken,
      refreshToken: input.refreshToken,
      userId: input.userId
    })
    try {
      return await runGenerate(input, emit, (jobId, state) => {
        registeredJobId = jobId
        activeRuns.set(jobId, state)
        // 准备窗口用户已点停止 → 任务一注册立即标记取消
        if (pendingCancel) state.aborted = true
        pendingCancel = false
      }, onQuotaUpdated)
    } catch (err) {
      // 主进程抛出任意值（如 Supabase PostgrestError 对象）时规范化为可读信息，
      // 避免 Electron 序列化成 [object Object] 导致 UI 看不到真实原因
      const msg =
        err instanceof Error
          ? err.message
          : err && typeof err === 'object'
            ? String((err as { message?: unknown }).message ?? JSON.stringify(err))
            : String(err)
      throw new Error(msg || '生成失败（未知错误）')
    } finally {
      if (registeredJobId) activeRuns.delete(registeredJobId)
      isGenerating = false
      pendingCancel = false
    }
  })

  ipcMain.handle('dispatch:cancel', (_e, jobId: unknown) => {
    // 优先按 jobId 定位；未匹配时回退到当前唯一活跃任务（渲染层事件丢失时也能停）
    let state: ActiveRunState | undefined
    if (typeof jobId === 'string' && jobId && activeRuns.has(jobId)) {
      state = activeRuns.get(jobId)
    } else if (activeRuns.size === 1) {
      const only = activeRuns.keys().next().value as string
      state = activeRuns.get(only)
    } else if (activeRuns.size > 1) {
      return { ok: false, reason: '存在多个进行中的任务，请稍后再试' }
    }
    if (!state) {
      // 生成已开始但任务尚未注册（准备窗口）→ 记待取消，注册后立即生效
      if (isGenerating) {
        pendingCancel = true
        return { ok: true }
      }
      return { ok: false, reason: '任务不存在或已结束' }
    }
    if (state.submitted) return { ok: false, reason: '提示词已发送，无法终止', submitted: true }
    state.aborted = true
    return { ok: true }
  })

  const sendWatermarkProgress = (progress: WatermarkProgress): void => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.webContents.isDestroyed()) {
        win.webContents.send('watermark:progress', progress)
      }
    }
  }

  ipcMain.handle('watermark:process', async (e, input: WatermarkJobInput) => {
    if (!input || typeof input.jobId !== 'string' || typeof input.userId !== 'string') {
      throw new Error('invalid watermark input')
    }
    const controller = new AbortController()
    activeWatermarkAborters.set(input.jobId, controller)
    try {
      return await processWatermarkJob({
        ...input,
        signal: controller.signal,
        onProgress: (progress) => {
          sendWatermarkProgress(progress)
          if (!e.sender.isDestroyed()) e.sender.send('watermark:progress', progress)
        }
      })
    } finally {
      activeWatermarkAborters.delete(input.jobId)
    }
  })

  ipcMain.handle('watermark:retry', async (e, input: WatermarkJobInput) => {
    if (!input || typeof input.jobId !== 'string' || typeof input.userId !== 'string') {
      throw new Error('invalid watermark input')
    }
    const controller = new AbortController()
    activeWatermarkAborters.set(input.jobId, controller)
    try {
      return await processWatermarkJob({
        ...input,
        signal: controller.signal,
        onProgress: (progress) => {
          sendWatermarkProgress(progress)
          if (!e.sender.isDestroyed()) e.sender.send('watermark:progress', progress)
        }
      })
    } finally {
      activeWatermarkAborters.delete(input.jobId)
    }
  })

  ipcMain.handle('watermark:cancel', (_e, jobId: unknown) => {
    if (typeof jobId !== 'string' || !jobId) throw new Error('invalid watermark job id')
    const controller = activeWatermarkAborters.get(jobId)
    controller?.abort()
    return { ok: !!controller }
  })

  ipcMain.handle('watermark:get-status', async (_e, input: Omit<WatermarkJobInput, 'bbox' | 'bboxes' | 'signal' | 'onProgress'>) => {
    if (!input || typeof input.jobId !== 'string' || typeof input.userId !== 'string') {
      throw new Error('invalid watermark input')
    }
    return getWatermarkStatus(input)
  })

  // reconciliation：启动时恢复崩溃残留 + 追记账本
  ipcMain.handle('dispatch:reconcile', async (
    _e,
    params: { supabaseUrl: string; supabaseAnonKey: string; accessToken: string; refreshToken: string; userId: string }
  ) => {
    try {
      const client = createSupabaseClient({
        supabaseUrl: params.supabaseUrl,
        supabaseAnonKey: params.supabaseAnonKey
      })
      await client.auth.setSession({ access_token: params.accessToken, refresh_token: params.refreshToken })
      const jobSvc = new JobService(client)
      const providerSvc = new ProviderService(client)
      let recovered = false

      // 1. 恢复崩溃残留：上次会话遗留的 pending/running → 标记为失败（不做自动恢复）。
      //    注意 jobs.status 的 DB CHECK 约束不含 'interrupted'，写失败(含约束)不报错。
      const { data: stuckJobs } = await client
        .from('jobs')
        .select('id, created_at')
        .eq('user_id', params.userId)
        .in('status', ['pending', 'running'])
        .order('created_at', { ascending: false })
        .limit(20)
      for (const j of (stuckJobs ?? [])) {
        await jobSvc.updateJob(params.userId, j.id, {
          status: 'failed',
          error: '应用意外退出，生成中断',
          completedAt: new Date().toISOString()
        })
        recovered = true
      }

      // 2. 追记未入账的成功任务（单 RPC 原子：检查→扣减→finalize 同一事务）
      const unfinalized = await providerSvc.findUnfinalizedJobs(params.userId)
      for (const u of unfinalized) {
        try {
          const rpcName = u.teamId ? 'team_consume_quota_and_finalize' : 'reconcile_consume_and_finalize'
          const rpcArgs = u.teamId
            ? {
                p_team_id: u.teamId,
                p_user_id: params.userId,
                p_provider_id: u.providerId ?? 'doubao',
                p_amount: u.costAmount,
                p_account_key_id: u.keyId,
                p_date: todayKey(),
                p_job_id: u.jobId
              }
            : {
                p_user_id: params.userId,
                p_provider_id: u.providerId ?? 'doubao',
                p_amount: u.costAmount,
                p_key_id: u.keyId,
                p_date: todayKey(),
                p_job_id: u.jobId
              }
          const { data, error } = await client.rpc(rpcName, rpcArgs)
          if (error) throw error
          const result = data as unknown as { ok: boolean; code?: string }
          if (result.ok && result.code !== 'ALREADY_FINALIZED') {
            recovered = true
          }
        } catch {
          // RPC 整体失败（网络/DB 异常）→ 事务回滚，额度未扣 → 下次 reconcile 重试安全
        }
      }

      return { ok: true, recovered }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  })
  initAutoUpdater(sendUpdaterStatus)
  initProviders()
  registerApiIpc()
  initCookieRenew()

  // 对外 HTTP API：上下文由渲染层登录后注入，或由 dispatch:generate 顺带缓存
  ipcMain.handle('api-server:configure', (_e, cfg: unknown) => {
    const c = (cfg ?? {}) as Partial<ApiContext>
    setApiContext({
      supabaseUrl: typeof c.supabaseUrl === 'string' ? c.supabaseUrl : undefined,
      supabaseAnonKey: typeof c.supabaseAnonKey === 'string' ? c.supabaseAnonKey : undefined,
      accessToken: typeof c.accessToken === 'string' ? c.accessToken : undefined,
      refreshToken: typeof c.refreshToken === 'string' ? c.refreshToken : undefined,
      userId: typeof c.userId === 'string' ? c.userId : undefined
    })
    return { ok: true }
  })
  initApiServer()

  // ---- 分镜编排 IPC（默认 raw 照抄，不做语义转换；核心是资源自动匹配）----
  ipcMain.handle('storyboard:pick-dir', async () => {
    const r = await dialog.showOpenDialog({ properties: ['openDirectory'] })
    if (r.canceled || r.filePaths.length === 0) return { canceled: true }
    return { canceled: false, dir: r.filePaths[0] }
  })

  // ---- 分镜编排进度文件（.storyboard-progress.json，记录每段 shot 的 jobId/remoteUrl/视频路径）----
  const readStoryboardProgress = (workDir: string): Record<string, { jobId?: string; remoteUrl?: string; videoPath?: string; status?: string; accountId?: string | null }> => {
    try {
      const p = join(workDir, '.storyboard-progress.json')
      if (!existsSync(p)) return {}
      const raw = JSON.parse(readFileSync(p, 'utf8'))
      return (raw && raw.shots) || {}
    } catch {
      return {}
    }
  }
  const writeStoryboardProgress = (workDir: string, index: number, entry: { jobId?: string | null; remoteUrl?: string | null; videoPath?: string; status?: string; accountId?: string | null }): void => {
    try {
      const p = join(workDir, '.storyboard-progress.json')
      let raw: { shots?: Record<string, unknown> } = {}
      if (existsSync(p)) {
        try { raw = JSON.parse(readFileSync(p, 'utf8')) } catch { raw = {} }
      }
      raw.shots = raw.shots || {}
      raw.shots[String(index)] = { ...(raw.shots[String(index)] as Record<string, unknown> || {}), ...entry }
      writeFileSync(p, JSON.stringify(raw, null, 2), 'utf8')
    } catch {}
  }

  ipcMain.handle('storyboard:parse', async (_e, params: { textPath?: string; workDir: string }) => {
    try {
      let textPath = params.textPath
      if (!textPath) {
        const mdFiles = await findStoryboardFiles(params.workDir)
        if (mdFiles.length === 0) return { ok: false, error: '工作目录里没有找到分镜文本（.md 文件）' }
        textPath = mdFiles[0]
      }
      const text = readFileSync(textPath, 'utf8')
      const shots = parseStoryboardText(text)
      // 资源自动匹配：@引用 → 工作目录下扫描到的图片绝对路径
      for (const shot of shots) {
        shot.images = await matchAssets(shot.refs, params.workDir)
      }
      const batchId = (textPath.split(/[\\/]/).pop() || 'storyboard').replace(/\.[^.]+$/, '')
      // 视频直接存工作目录：workDir/shots/shot_NNN.mp4，合并出 workDir/final.mp4
      const batchDir = params.workDir
      const shotsDir = join(batchDir, 'shots')
      mkdirSync(shotsDir, { recursive: true })
      // 进度恢复：读进度文件 + 扫 shots 目录，关联已生成视频 / 记录 remoteUrl（供补回）
      const savedProgress = readStoryboardProgress(params.workDir)
      const progress: Record<number, { jobId?: string; remoteUrl?: string; videoPath?: string; status?: string; accountId?: string | null }> = {}
      for (const shot of shots) {
        const idx = shot.index
        const saved = savedProgress[String(idx)] || {}
        const filePath = join(shotsDir, shotFileName(idx))
        if (existsSync(filePath)) {
          progress[idx] = { ...saved, videoPath: filePath, status: 'done' }
        } else if (saved.remoteUrl) {
          // 文件已丢失但进度里还有 remoteUrl：清掉 videoPath（避免前端误判「文件还在」），
          // 保留 remoteUrl/jobId/accountId 供「补下载」和「打开豆包」两个兜底
          progress[idx] = { ...saved, videoPath: undefined, status: 'error' }
        } else if (saved.jobId || saved.accountId) {
          // 生成失败（无 URL）：保留失败状态 + accountId（供「打开豆包」人工兜底）
          progress[idx] = { ...saved, videoPath: undefined, status: 'error' }
        }
      }
      return { ok: true, result: { batchId, provider: 'doubao', textPath, batchDir, shotsDir, shots, progress } }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.handle(
    'storyboard:generate',
    async (_e, params: { gen: Parameters<typeof runGenerate>[0]; batchDir: string; index: number }) => {
      logGeneration('storyboard-generate-start', { index: params.index, durationSec: params.gen.durationSec, preferredAccountId: params.gen.preferredAccountId ?? null, mode: params.gen.mode })
      try {
        const result = await runGenerate(params.gen, () => {}, undefined, undefined)
        logGeneration('storyboard-generate-result', { index: params.index, ok: result.ok, jobId: result.jobId ?? null, error: result.error ?? null, accountId: result.accountId ?? null, hasRemoteUrl: !!result.remoteUrl })
        if (!result.ok || !result.jobId) {
          writeStoryboardProgress(params.batchDir, params.index, { jobId: result.jobId || null, remoteUrl: null, accountId: result.accountId || null, status: 'error' })
          return { ok: false, error: result.error || '生成失败', accountId: result.accountId ?? null }
        }
        let src = join(app.getPath('userData'), 'videos', `${result.jobId}.mp4`)
        if (!existsSync(src) && result.remoteUrl) {
          // 补下载：runGenerate 内下载失败（如 Node 不走系统代理），用 remoteUrl 重试
          const retried = await downloadVideo(result.remoteUrl, result.jobId, 'doubao')
          if (retried) src = retried
        }
        if (!existsSync(src)) {
          writeStoryboardProgress(params.batchDir, params.index, { jobId: result.jobId, remoteUrl: result.remoteUrl || null, status: 'error' })
          return { ok: false, error: '视频未落盘（可能下载失败）', jobId: result.jobId, remoteUrl: result.remoteUrl || null, accountId: result.accountId ?? null }
        }
        const shotsDir = join(params.batchDir, 'shots')
        mkdirSync(shotsDir, { recursive: true })
        const dst = join(shotsDir, shotFileName(params.index))
        copyFileSync(src, dst)
        writeStoryboardProgress(params.batchDir, params.index, { jobId: result.jobId, remoteUrl: result.remoteUrl || null, videoPath: dst, status: 'done', accountId: result.accountId ?? null })
        return { ok: true, videoPath: dst, jobId: result.jobId }
      } catch (e) {
        logGeneration('storyboard-generate-exception', { index: params.index, error: e })
        return { ok: false, error: e instanceof Error ? e.message : String(e) }
      }
    }
  )

  ipcMain.handle('storyboard:diagnostics-path', async () => ({ ok: true, path: generationLogPath() }))

  ipcMain.handle('storyboard:merge', async (_e, params: { batchDir: string }) => {
    try {
      const shotsDir = join(params.batchDir, 'shots')
      const files = readdirSync(shotsDir).filter((f) => /^shot_\d+\.mp4$/.test(f))
      files.sort((a, b) => parseInt(a.match(/\d+/)![0], 10) - parseInt(b.match(/\d+/)![0], 10))
      if (files.length === 0) return { ok: false, error: '没有已生成的片段' }
      const finalPath = join(params.batchDir, 'final.mp4')
      await mergeVideos(files.map((f) => join(shotsDir, f)), finalPath)
      return { ok: true, output: finalPath }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.handle('storyboard:re-download', async (_e, params: { remoteUrl: string; jobId: string; batchDir: string; index: number }) => {
    try {
      if (!params.remoteUrl) return { ok: false, error: '缺少远程视频 URL' }
      let dlError = ''
      const downloaded = await downloadVideo(params.remoteUrl, params.jobId, 'doubao', 0, (reason) => { dlError = reason })
      if (!downloaded) return { ok: false, error: dlError || '补下载失败' }
      const shotsDir = join(params.batchDir, 'shots')
      mkdirSync(shotsDir, { recursive: true })
      const dst = join(shotsDir, shotFileName(params.index))
      copyFileSync(downloaded, dst)
      writeStoryboardProgress(params.batchDir, params.index, { jobId: params.jobId, remoteUrl: params.remoteUrl, videoPath: dst, status: 'done' })
      return { ok: true, videoPath: dst }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  // 手动填 URL 下载（第四层兜底）：程序判断失败/无 URL 时，用户从别处复制视频链接粘贴下载到对应 shot
  ipcMain.handle('storyboard:manual-download', async (_e, params: { url: string; batchDir: string; index: number }) => {
    try {
      const url = (params.url || '').trim()
      if (!url) return { ok: false, error: '请填写视频 URL' }
      if (!/^https?:\/\//i.test(url)) return { ok: false, error: 'URL 格式无效，需以 http(s):// 开头' }
      let dlError = ''
      const jobId = `manual-${params.index}-${Date.now()}`
      const downloaded = await downloadVideo(url, jobId, 'doubao', 0, (reason) => { dlError = reason })
      if (!downloaded) return { ok: false, error: dlError || '下载失败' }
      const shotsDir = join(params.batchDir, 'shots')
      mkdirSync(shotsDir, { recursive: true })
      const dst = join(shotsDir, shotFileName(params.index))
      copyFileSync(downloaded, dst)
      writeStoryboardProgress(params.batchDir, params.index, { jobId, remoteUrl: url, videoPath: dst, status: 'done' })
      return { ok: true, videoPath: dst }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.handle('job:re-download', async (_e, params: { jobId: string; remoteUrl: string; userId: string; supabaseUrl: string; supabaseAnonKey: string; accessToken: string; refreshToken: string }) => {
    try {
      let dlError = ''
      const downloaded = await downloadVideo(params.remoteUrl, params.jobId, 'doubao', 0, (reason) => { dlError = reason })
      if (!downloaded) return { ok: false, error: dlError || '补下载失败' }
      try {
        const client = createSupabaseClient({ supabaseUrl: params.supabaseUrl, supabaseAnonKey: params.supabaseAnonKey })
        await client.auth.setSession({ access_token: params.accessToken, refresh_token: params.refreshToken })
        const { data: job } = await client.from('jobs').select('options').eq('id', params.jobId).eq('user_id', params.userId).single()
        const existingOptions = (job?.options as Record<string, unknown>) || {}
        const jobSvc = new JobService(client)
        await jobSvc.updateJob(params.userId, params.jobId, {
          options: { ...existingOptions, localPath: downloaded, originalLocalPath: downloaded, cleanLocalPath: null }
        })
      } catch {
        // 更新 job 记录失败不阻断（视频已下载到本地）
      }
      return { ok: true, videoPath: downloaded }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  // 打开豆包页面（人工兜底）：自动化超时/风控未取到 URL 时，用对应账号分区重开豆包页，让用户手动去历史里下载
  ipcMain.handle('doubao:open-page', async (_e, params: { keyId?: string }) => {
    try {
      return openDoubaoPage(params.keyId)
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  // 从已打开的豆包窗口提取最新视频并下载到对应 shot（人工看到视频后手动触发）
  ipcMain.handle('doubao:download-latest', async (_e, params: { keyId?: string; batchDir: string; index: number }) => {
    try {
      const r = await extractLatestDoubaoVideoUrl(params.keyId)
      if (!r.ok || !r.videoUrl) return { ok: false, error: r.error || '未提取到视频 URL' }
      let dlError = ''
      const jobId = `manual-${params.index}-${Date.now()}`
      const downloaded = await downloadVideo(r.videoUrl, jobId, 'doubao', 0, (reason) => { dlError = reason })
      if (!downloaded) return { ok: false, error: dlError || '下载失败' }
      const shotsDir = join(params.batchDir, 'shots')
      mkdirSync(shotsDir, { recursive: true })
      const dst = join(shotsDir, shotFileName(params.index))
      copyFileSync(downloaded, dst)
      writeStoryboardProgress(params.batchDir, params.index, { jobId, remoteUrl: r.videoUrl, videoPath: dst, status: 'done' })
      return { ok: true, videoPath: dst }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  // 提取豆包窗口里所有视频（供「选视频」兜底：用户挑任意一条下载，非只取最后一条）
  ipcMain.handle('doubao:list-videos', async (_e, params: { keyId?: string }) => {
    try {
      return extractAllDoubaoVideos(params.keyId)
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  // 自动拉取：生成失败后，后台隐藏窗口重开豆包页轮询提取最新视频，带次数限制
  ipcMain.handle('doubao:auto-retry', async (_e, params: { keyId?: string; batchDir: string; index: number; maxAttempts?: number }) => {
    try {
      const r = await autoRetryExtractDoubaoVideo(params.keyId, params.maxAttempts ?? 3, 20000)
      if (!r.ok || !r.videoUrl) return { ok: false, error: r.error || '自动拉取失败' }
      let dlError = ''
      const jobId = `auto-${params.index}-${Date.now()}`
      const downloaded = await downloadVideo(r.videoUrl, jobId, 'doubao', 0, (reason) => { dlError = reason })
      if (!downloaded) return { ok: false, error: dlError || '下载失败' }
      const shotsDir = join(params.batchDir, 'shots')
      mkdirSync(shotsDir, { recursive: true })
      const dst = join(shotsDir, shotFileName(params.index))
      copyFileSync(downloaded, dst)
      writeStoryboardProgress(params.batchDir, params.index, { jobId, remoteUrl: r.videoUrl, videoPath: dst, status: 'done' })
      return { ok: true, videoPath: dst }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
