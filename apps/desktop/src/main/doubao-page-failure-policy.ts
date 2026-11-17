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
