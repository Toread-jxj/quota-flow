import { describe, expect, it } from 'vitest'
import {
  classifyDoubaoUserClose,
  shouldAbortDoubaoUpload,
  shouldCloseDoubaoWindow
} from './webview-lifecycle-policy'

describe('classifyDoubaoUserClose', () => {
  it('提交前关闭判定为未完成，提交后关闭判定为待找回', () => {
    expect(classifyDoubaoUserClose(false, false)).toBe('cancelled-before-submit')
    expect(classifyDoubaoUserClose(true, false)).toBe('submitted-pending-recovery')
    expect(classifyDoubaoUserClose(false, true)).toBe('submitted-pending-recovery')
  })
})

describe('shouldAbortDoubaoUpload', () => {
  it('用户关闭窗口或点击停止时立即结束上传等待', () => {
    expect(shouldAbortDoubaoUpload(false, false)).toBe(false)
    expect(shouldAbortDoubaoUpload(true, false)).toBe(true)
    expect(shouldAbortDoubaoUpload(false, true)).toBe(true)
  })
})

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
    expect(shouldCloseDoubaoWindow('user-closed')).toBe(false)
  })
})
