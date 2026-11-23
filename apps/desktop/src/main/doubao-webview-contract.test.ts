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

  it('主提示词提交必须使用 Electron 原生 Enter，且不得用输入框清空作为成功硬门槛', () => {
    const text = source()
    const imgSubmitStart = text.indexOf('const insertPromptAndSubmitScript')
    const confirmStart = text.indexOf('const appendAndSubmitTextScript', imgSubmitStart)
    const imgSubmitBlock = text.slice(imgSubmitStart, confirmStart)
    const textSubmitStart = text.indexOf('const fillAndSubmitScript', confirmStart)
    const extractStart = text.indexOf('const extractResultScript', textSubmitStart)
    const textSubmitBlock = text.slice(textSubmitStart, extractStart)
    for (const submitBlock of [imgSubmitBlock, textSubmitBlock]) {
      expect(submitBlock).not.toContain("new KeyboardEvent('keydown'")
      expect(submitBlock).not.toContain('editorAfter')
      expect(submitBlock).not.toContain("reason: '已触发提交但页面未确认提示词发送成功'")
    }
    expect(text).toContain("sendDoubaoNativeEnter(win)")
    expect(text).toContain("win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'ENTER' })")
    expect(text).toContain("win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'ENTER' })")
  })

  it('时长滑块必须使用 Electron 原生方向键，页面脚本只负责聚焦手柄', () => {
    const text = source()
    const focusStart = text.indexOf('const focusDurationSliderScript')
    const closeStart = text.indexOf('const closeDurationMenuScript', focusStart)
    const focusBlock = text.slice(focusStart, closeStart)
    expect(focusStart).toBeGreaterThan(-1)
    expect(focusBlock).not.toContain('new KeyboardEvent')
    expect(text).toContain('sendDoubaoNativeSliderKey(win, dir)')
    expect(text).toContain("const keyCode = dir === 'left' ? 'LEFT' : 'RIGHT'")
    expect(text).toContain('next !== expected')
    expect(text).toContain("typeof value !== 'string' || value.trim() === ''")
    expect(text).not.toContain('okByText')
    expect(text).not.toContain('curSec === target')
  })
})
