export type AccountRetryDecision = {
  retry: boolean
  expireAccount: boolean
  reason: 'preferred-account-locked' | 'account-auth-failure' | 'account-quota-failure' | 'page-or-submit-failure'
}

/**
 * 仅明确的账号级故障允许自动换号。
 * DOM、上传、提交、风控、等待和结果提取失败均属于当前页面/任务故障，换号无助且会破坏现场。
 * 豆包规则不应改变其他厂商的既有调度语义。
 */
export function decideAccountRetry(error: string, preferredAccount: boolean, providerId = 'doubao'): AccountRetryDecision {
  if (providerId !== 'doubao') {
    // 本轮仅定义豆包策略；其他厂商由 dispatch 保持原有重试/健康态逻辑，不调用本函数。
    return { retry: false, expireAccount: false, reason: preferredAccount ? 'preferred-account-locked' : 'page-or-submit-failure' }
  }

  const ambiguousPageFailure = /可能未登录|可能登录态失效|或风控限制|页面结构(?:变化|不同)|未找到输入框/i.test(error)
  const authFailure = !ambiguousPageFailure && /账号未登录|账号.*登录态.*失效|登录态.*失效|cookie.*(?:失效|解密失败)|账号.*失效/i.test(error)
  const quotaFailure = /(?:额度|次数).*(?:不足|耗尽|用完|用尽|上限)|(?:达到|超过).*(?:额度|次数|生成次数).*上限|明天再来.*免费/i.test(error)

  if (preferredAccount) {
    return { retry: false, expireAccount: authFailure, reason: 'preferred-account-locked' }
  }
  if (authFailure) {
    return { retry: true, expireAccount: true, reason: 'account-auth-failure' }
  }
  if (quotaFailure) {
    return { retry: true, expireAccount: false, reason: 'account-quota-failure' }
  }
  return { retry: false, expireAccount: false, reason: 'page-or-submit-failure' }
}
