import { describe, expect, it } from 'vitest'
import { shouldCloseDoubaoWindow } from './webview-lifecycle-policy'

describe('shouldCloseDoubaoWindow', () => {
  it('上传检测和提交失败时保留窗口供人工检查', () => {
    expect(shouldCloseDoubaoWindow('upload-check-failed')).toBe(false)
    expect(shouldCloseDoubaoWindow('submit-failed')).toBe(false)
  })

  it('等待期间不关闭窗口', () => {
    expect(shouldCloseDoubaoWindow('waiting')).toBe(false)
  })

  it('只有明确取得本次视频 URL 才允许自动关闭', () => {
    expect(shouldCloseDoubaoWindow('success')).toBe(true)
    expect(shouldCloseDoubaoWindow('account-auth-failed')).toBe(false)
    expect(shouldCloseDoubaoWindow('cancelled')).toBe(false)
    expect(shouldCloseDoubaoWindow('timeout')).toBe(false)
    expect(shouldCloseDoubaoWindow('blocked')).toBe(false)
    expect(shouldCloseDoubaoWindow('rate-limited')).toBe(false)
  })
})
