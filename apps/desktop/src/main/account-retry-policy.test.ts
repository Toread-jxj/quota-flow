import { describe, expect, it } from 'vitest'
import { decideAccountRetry } from './account-retry-policy'

describe('decideAccountRetry', () => {
  it('图片上传检测失败时停止并保留当前账号，不切换账号', () => {
    expect(decideAccountRetry('图片上传失败（豆包界面未确认图片上传完成），请确认图片格式后重试', false, 'doubao'))
      .toEqual({ retry: false, expireAccount: false, reason: 'page-or-submit-failure' })
  })

  it('提交失败或等待超时时不切换账号', () => {
    expect(decideAccountRetry('提示词未成功进入输入框，已中止以避免误报生成中', false, 'doubao').retry).toBe(false)
    expect(decideAccountRetry('等待超时未取到视频 URL', false, 'doubao').retry).toBe(false)
  })

  it('明确登录态失效时允许自动换号并标记账号失效', () => {
    expect(decideAccountRetry('豆包账号未登录（cookie 可能已失效）', false, 'doubao'))
      .toEqual({ retry: true, expireAccount: true, reason: 'account-auth-failure' })
  })

  it('不确定的登录态或风控提示不得换号或封禁', () => {
    for (const error of [
      '可能登录态失效或风控限制',
      '豆包页面未找到输入框（可能未登录或页面结构变化）'
    ]) {
      expect(decideAccountRetry(error, false, 'doubao'))
        .toEqual({ retry: false, expireAccount: false, reason: 'page-or-submit-failure' })
    }
  })

  it('明确远端额度耗尽时允许自动换号但不标记登录态失效', () => {
    for (const error of ['当前账号今日额度已耗尽', '已达到生成次数上限', '免费生成次数已用尽', '明天再来可继续免费生成']) {
      expect(decideAccountRetry(error, false, 'doubao'))
        .toEqual({ retry: true, expireAccount: false, reason: 'account-quota-failure' })
    }
  })

  it('手工指定账号失败时永不换号', () => {
    expect(decideAccountRetry('豆包账号未登录（cookie 可能已失效）', true, 'doubao'))
      .toEqual({ retry: false, expireAccount: true, reason: 'preferred-account-locked' })
  })

})
