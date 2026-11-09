// Quota-Flow 对外 HTTP API（跑在 Electron 主进程内）
// 目标：把桌面端现有的统一调度入口 runGenerate 包成 HTTP，供外部系统（分镜编排 skill 等）调用。
//
// 路由：
//   GET  /health          健康检查 + 上下文是否就绪
//   POST /v1/generate     生成视频（业务参数 + 可选 supabase 上下文；缺省用缓存上下文补全）
//   GET  /v1/quota        额度查询（MVP 占位）
//   POST /v1/estimate     消耗预估（MVP 占位）
//
// 上下文：supabase 连接 + 登录态由渲染层通过 IPC 'api-server:configure' 注入，
//         或由 dispatch:generate 在用户通过 UI 生成时顺带缓存。外部系统无需接触密钥。

import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { app } from 'electron'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { runGenerate } from './dispatch'
import type { GenerateInput } from './dispatch'

export interface ApiContext {
  supabaseUrl: string
  supabaseAnonKey: string
  accessToken: string
  refreshToken: string
  userId: string
}

let ctx: ApiContext | null = null
let currentPort: number | null = null

/** 注入/更新默认上下文（渲染层登录后调用）。 */
export function setApiContext(c: Partial<ApiContext>): void {
  ctx = { ...(ctx ?? ({} as ApiContext)), ...c }
  // supabaseUrl 等仍是空串时视为未就绪，由 /v1/generate 校验兜底
}

export function getApiPort(): number | null {
  return currentPort
}

function readBody(req: IncomingMessage, limitBytes = 2 * 1024 * 1024): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > limitBytes) {
        reject(new Error('请求体过大'))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => {
      if (chunks.length === 0) return resolve({})
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>)
      } catch (e) {
        reject(new Error('请求体不是合法 JSON'))
      }
    })
    req.on('error', reject)
  })
}

function json(res: ServerResponse, code: number, obj: unknown): void {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(obj))
}

/** 业务参数字段白名单：从 body 透传给 GenerateInput，避免外部注入 supabase/身份字段绕过上下文 */
const BUSINESS_FIELDS: Array<keyof GenerateInput> = [
  'prompt',
  'providerId',
  'model',
  'durationSec',
  'mode',
  'resolution',
  'audio',
  'ratio',
  'images',
  'imageUrls',
  'videos',
  'videoUrls',
  'audioUrl',
  'template',
  'teamId'
]

function buildGenerateInput(body: Record<string, unknown>): GenerateInput {
  // supabase / 身份字段：优先用请求体显式值（高级调用方自备），缺省回退缓存上下文
  const supabaseUrl = (body.supabaseUrl as string) || ctx?.supabaseUrl || ''
  const supabaseAnonKey = (body.supabaseAnonKey as string) || ctx?.supabaseAnonKey || ''
  const accessToken = (body.accessToken as string) || ctx?.accessToken || ''
  const refreshToken = (body.refreshToken as string) || ctx?.refreshToken || ''
  const userId = (body.userId as string) || ctx?.userId || ''

  const input = {
    supabaseUrl,
    supabaseAnonKey,
    accessToken,
    refreshToken,
    userId
  } as unknown as GenerateInput

  for (const field of BUSINESS_FIELDS) {
    if (body[field] !== undefined && body[field] !== null) {
      ;(input as unknown as Record<string, unknown>)[field] = body[field]
    }
  }
  return input
}

function videoLocalPath(jobId: string): string {
  return join(app.getPath('userData'), 'videos', `${jobId}.mp4`)
}

export function initApiServer(): void {
  const server = createServer(async (req, res) => {
    const path = (req.url || '').split('?')[0]
    try {
      // ---- 健康检查 ----
      if (req.method === 'GET' && path === '/health') {
        return json(res, 200, {
          ok: true,
          service: 'quota-flow-api',
          ctxReady: Boolean(ctx && ctx.supabaseUrl && ctx.userId),
          port: currentPort
        })
      }

      // ---- 生成视频 ----
      if (req.method === 'POST' && path === '/v1/generate') {
        const body = await readBody(req)
        const input = buildGenerateInput(body)

        if (!input.providerId || typeof input.providerId !== 'string') {
          return json(res, 400, { ok: false, error: '缺少 providerId' })
        }
        if (!input.prompt || typeof input.prompt !== 'string') {
          return json(res, 400, { ok: false, error: '缺少 prompt' })
        }
        if (!input.supabaseUrl || !input.userId) {
          return json(res, 400, {
            ok: false,
            error: '缺少 Supabase 上下文（请先登录桌面端，或在请求体传入 supabaseUrl/accessToken/userId）'
          })
        }

        // 转调统一调度入口（含厂商分流 + 选号 + 额度 + 执行 + 落盘）
        const result = await runGenerate(input, () => {}, undefined, undefined)

        if (!result.ok || !result.jobId) {
          return json(res, 200, { ok: false, error: result.error || '生成失败' })
        }
        const localPath = videoLocalPath(result.jobId)
        const hasLocal = existsSync(localPath)
        return json(res, 200, {
          ok: true,
          jobId: result.jobId,
          videoPath: hasLocal ? localPath : null,
          note: hasLocal ? undefined : '本地视频未落盘（可能下载失败，远端 URL 见 jobs 表）'
        })
      }

      // ---- 额度查询（MVP 占位） ----
      if (req.method === 'GET' && path === '/v1/quota') {
        return json(res, 200, { ok: true, note: 'quota 接口待实现（MVP 占位）' })
      }

      // ---- 消耗预估（MVP 占位） ----
      if (req.method === 'POST' && path === '/v1/estimate') {
        return json(res, 200, { ok: true, note: 'estimate 接口待实现（MVP 占位）' })
      }

      return json(res, 404, { ok: false, error: `未知路径: ${path}` })
    } catch (e) {
      return json(res, 500, { ok: false, error: e instanceof Error ? e.message : String(e) })
    }
  })

  const port = Number(process.env.QF_API_PORT) || 18790
  server.on('error', (err) => {
    // 端口被占用等：仅记录，不阻断桌面端启动
    console.error('[api-server] 启动失败:', err)
  })
  server.listen(port, '127.0.0.1', () => {
    currentPort = port
    try {
      writeFileSync(join(app.getPath('userData'), 'api-port.txt'), String(port), 'utf8')
    } catch {
      // 写端口文件失败不影响服务
    }
    console.log(`[api-server] 监听 http://127.0.0.1:${port}`)
  })
}
