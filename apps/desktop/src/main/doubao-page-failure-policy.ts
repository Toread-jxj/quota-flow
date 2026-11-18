export function findNewDoubaoFailureSignal(
  baseline: string[],
  current: string[]
): string | null {
  const baselineCounts = new Map<string, number>()
  for (const signal of baseline) baselineCounts.set(signal, (baselineCounts.get(signal) ?? 0) + 1)

  const currentCounts = new Map<string, number>()
  for (const signal of current) currentCounts.set(signal, (currentCounts.get(signal) ?? 0) + 1)

  for (const signal of current) {
    if ((currentCounts.get(signal) ?? 0) > (baselineCounts.get(signal) ?? 0)) return signal
  }
  return null
}

export function hasNewDoubaoFailureCount(
  baselineReady: boolean,
  baselineCount: number,
  currentCount: number
): boolean {
  return baselineReady && currentCount > baselineCount
}

export function shouldStartDoubaoManagedWindow(
  hasExistingWindow: boolean,
  generationStarting: boolean
): boolean {
  return !hasExistingWindow && !generationStarting
}

export type DoubaoChildWindowDecision = 'allow' | 'focus-main' | 'deny'

/** 豆包主窗口不得再弹出第二个豆包聊天主页面；非豆包 http(s) 登录/验证窗口维持现有放行。 */
export function decideDoubaoChildWindow(url: string): DoubaoChildWindowDecision {
  try {
    const target = new URL(url)
    if (target.protocol !== 'http:' && target.protocol !== 'https:') return 'deny'
    const host = target.hostname.toLowerCase()
    const isDoubaoHost = host === 'doubao.com' || host.endsWith('.doubao.com')
    if (isDoubaoHost && /^\/chat(?:\/|$)/.test(target.pathname)) return 'focus-main'
    return 'allow'
  } catch {
    return 'deny'
  }
}
