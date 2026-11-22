import { describe, expect, it } from 'vitest'
import { decideDoubaoPageReadiness } from './doubao-page-readiness-policy'

describe('豆包页面首次就绪判断', () => {
  it('慢渲染期间保持等待，输入框出现后才继续', () => {
    const pending = { inputFound: false, videoEntryFound: false, hasLoginWall: false }
    expect(decideDoubaoPageReadiness(pending, false)).toBe('wait')
    expect(decideDoubaoPageReadiness(pending, false)).toBe('wait')
    expect(decideDoubaoPageReadiness({ ...pending, inputFound: true }, false)).toBe('ready')
  })

  it('视频生成入口先出现时允许进入后续既有流程', () => {
    expect(decideDoubaoPageReadiness({
      inputFound: false,
      videoEntryFound: true,
      hasLoginWall: false
    }, false)).toBe('ready')
  })

  it('明确登录墙出现时优先报告登录要求，即使页面同时存在输入框或视频入口', () => {
    expect(decideDoubaoPageReadiness({
      inputFound: true,
      videoEntryFound: true,
      hasLoginWall: true
    }, false)).toBe('login-required')
  })

  it('期限结束仍没有可操作节点时才报告超时', () => {
    expect(decideDoubaoPageReadiness({
      inputFound: false,
      videoEntryFound: false,
      hasLoginWall: false
    }, true)).toBe('timeout')
  })

  it('尚未渲染用户信息不能单独判定为未登录', () => {
    expect(decideDoubaoPageReadiness({
      inputFound: false,
      videoEntryFound: false,
      hasLoginWall: false,
      hasUserInfo: false
    }, false)).toBe('wait')
  })
})
