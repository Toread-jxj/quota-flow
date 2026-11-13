import { describe, expect, it } from 'vitest'
import {
  raceDoubaoOperationWithClose,
  shouldAbortDoubaoUpload,
  shouldCloseDoubaoWindow
} from './webview-lifecycle-policy'

function closeSignal(): { signal: Promise<void>; close: () => void } {
  let close!: () => void
  const signal = new Promise<void>((resolve) => { close = resolve })
  return { signal, close }
}

describe('raceDoubaoOperationWithClose', () => {
  it('窗口关闭后立即结束当前页面操作', async () => {
    const current = closeSignal()
    const pending = new Promise<string>(() => {})
    const result = raceDoubaoOperationWithClose(pending, current.signal)

    current.close()

    await expect(result).resolves.toEqual({ closed: true })
  })

  it('连续两次打开并关闭时每次都独立结束，不残留上一轮状态', async () => {
    const first = closeSignal()
    const firstResult = raceDoubaoOperationWithClose(new Promise<string>(() => {}), first.signal)
    first.close()
    await expect(firstResult).resolves.toEqual({ closed: true })

    const second = closeSignal()
    const secondResult = raceDoubaoOperationWithClose(new Promise<string>(() => {}), second.signal)
    second.close()
    await expect(secondResult).resolves.toEqual({ closed: true })
  })

  it('窗口先关闭时忽略随后到达的页面销毁错误', async () => {
    const current = closeSignal()
    let rejectOperation!: (error: Error) => void
    const operation = new Promise<string>((_, reject) => { rejectOperation = reject })
    const result = raceDoubaoOperationWithClose(operation, current.signal)

    current.close()
    rejectOperation(new Error('Object has been destroyed'))

    await expect(result).resolves.toEqual({ closed: true })
  })

  it('窗口未关闭时保留真实页面错误', async () => {
    const current = closeSignal()
    await expect(
      raceDoubaoOperationWithClose(Promise.reject(new Error('页面操作失败')), current.signal)
    ).rejects.toThrow('页面操作失败')
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
