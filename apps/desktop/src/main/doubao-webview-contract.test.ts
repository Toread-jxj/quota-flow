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

  it('首次页面检查必须轮询等待输入框或视频生成入口，不能单次未命中就失败', () => {
    const text = source()
    const inspectStart = text.indexOf("progress(options, 'wait-page-ready')")
    const waitTab = text.indexOf("progress(options, 'wait-tab')", inspectStart)
    expect(inspectStart).toBeGreaterThan(-1)
    expect(waitTab).toBeGreaterThan(inspectStart)
    const readinessBlock = text.slice(inspectStart, waitTab)
    expect(readinessBlock).toContain('decideDoubaoPageReadiness')
    expect(readinessBlock).toContain("readiness !== 'wait'")
    expect(readinessBlock).toContain("readiness === 'login-required'")
    expect(readinessBlock).toContain("readiness === 'timeout'")
    const inspectScriptBlock = text.slice(text.indexOf('const inspectScript'), text.indexOf('const openVideoTabScript'))
    expect(inspectScriptBlock).toContain("button, [role=\"button\"], [role=\"tab\"]")
    expect(inspectScriptBlock).toContain("getAttribute('aria-label')")
    expect(inspectScriptBlock).toContain("getAttribute('title')")
    expect(inspectScriptBlock.indexOf('.slice(0, 20)')).toBe(-1)
  })
})
