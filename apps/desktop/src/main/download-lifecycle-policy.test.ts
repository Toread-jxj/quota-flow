import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveDownloadRedirect } from './download-policy'

function source(): string {
  return readFileSync(resolve(process.cwd(), 'src/main/dispatch.ts'), 'utf8')
}

describe('视频下载完成边界', () => {
  it('响应流异常、中止、超时或提前关闭都必须结束下载 Promise', () => {
    const text = source()
    const start = text.indexOf('export function downloadVideo(')
    const end = text.indexOf('/**\n * 判断本地视频是否为 HEVC', start)
    const block = text.slice(start, end)

    expect(block).toContain("res.on('error'")
    expect(block).toContain("res.on('aborted'")
    expect(block).toContain("res.on('close'")
    expect(block).toContain('res.setTimeout(90000')
    expect(block).toContain('responseEnded')
    expect(block).toContain('finish(false, null')
  })

  it('相对重定向解析为同源 HTTPS 绝对地址', () => {
    expect(resolveDownloadRedirect('https://example.com/a/start', '../video.mp4')).toEqual({
      ok: true,
      url: 'https://example.com/video.mp4'
    })
  })

  it('拒绝 HTTP 和无效重定向，不能把同步异常留给父 Promise', () => {
    expect(resolveDownloadRedirect('https://example.com/start', 'http://example.com/video.mp4')).toEqual({
      ok: false,
      reason: '不支持的重定向协议：http:'
    })
    expect(resolveDownloadRedirect('not-a-url', '::::')).toMatchObject({ ok: false })
  })
})
