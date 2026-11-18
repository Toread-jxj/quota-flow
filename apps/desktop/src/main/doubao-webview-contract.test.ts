import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

function source(): string {
  return readFileSync(resolve(process.cwd(), 'src/main/webview-engine.ts'), 'utf8')
}

describe('豆包网页请求与子窗口合同', () => {
  it('不得擅自把豆包上传或提交 XHR 改成固定 30 秒超时', () => {
    const text = source()
    expect(text).not.toContain('x.timeout = 30000')
  })

  it('生成和人工兜底窗口都必须使用三态子窗口决策', () => {
    const text = source()
    expect(text.match(/decideDoubaoChildWindow\(url\)/g)?.length).toBe(2)
    expect(text).toContain("decision === 'focus-main'")
    expect(text).toContain("decision === 'deny'")
  })
})
