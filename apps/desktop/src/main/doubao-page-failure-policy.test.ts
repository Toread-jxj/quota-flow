import { describe, expect, it } from 'vitest'
import {
  findNewDoubaoFailureSignal,
  hasNewDoubaoFailureCount,
  shouldStartDoubaoManagedWindow
} from './doubao-page-failure-policy'

describe('findNewDoubaoFailureSignal', () => {
  it('只把提交后新增的发送失败状态判为本次失败', () => {
    const baseline = ['send-retry-visible']
    const current = ['send-retry-visible', 'send-retry-visible']

    expect(findNewDoubaoFailureSignal(baseline, current)).toBe('send-retry-visible')
  })

  it('历史失败状态数量没有增加时不误判本次提交', () => {
    const baseline = ['send-retry-visible']
    const current = ['send-retry-visible']

    expect(findNewDoubaoFailureSignal(baseline, current)).toBeNull()
  })

  it('上传失败信号也能独立识别', () => {
    expect(findNewDoubaoFailureSignal([], ['upload-retry-visible']))
      .toBe('upload-retry-visible')
  })
})

describe('hasNewDoubaoFailureCount', () => {
  it('baseline 不可用时不把历史失败数量当成本次新增', () => {
    expect(hasNewDoubaoFailureCount(false, 0, 1)).toBe(false)
    expect(hasNewDoubaoFailureCount(true, 1, 2)).toBe(true)
    expect(hasNewDoubaoFailureCount(true, 1, 1)).toBe(false)
  })
})

describe('shouldStartDoubaoManagedWindow', () => {
  it('同账号已有窗口时阻止创建新窗口', () => {
    expect(shouldStartDoubaoManagedWindow(true, false)).toBe(false)
  })

  it('同账号已有生成正在启动时阻止并发创建', () => {
    expect(shouldStartDoubaoManagedWindow(false, true)).toBe(false)
  })

  it('该账号没有窗口且没有启动中的生成时允许创建', () => {
    expect(shouldStartDoubaoManagedWindow(false, false)).toBe(true)
  })
})
