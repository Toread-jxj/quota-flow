export interface DoubaoPageReadinessSnapshot {
  inputFound?: boolean
  videoEntryFound?: boolean
  hasLoginWall?: boolean
  hasUserInfo?: boolean
}

export type DoubaoPageReadinessDecision = 'wait' | 'ready' | 'login-required' | 'timeout'

export function decideDoubaoPageReadiness(
  snapshot: DoubaoPageReadinessSnapshot,
  deadlineReached: boolean
): DoubaoPageReadinessDecision {
  if (snapshot.hasLoginWall === true) return 'login-required'
  if (snapshot.inputFound === true || snapshot.videoEntryFound === true) return 'ready'
  return deadlineReached ? 'timeout' : 'wait'
}
