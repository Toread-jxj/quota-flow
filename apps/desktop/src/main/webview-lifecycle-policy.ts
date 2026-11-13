export type DoubaoWindowTerminalReason =
  | 'upload-check-failed'
  | 'submit-failed'
  | 'waiting'
  | 'success'
  | 'account-auth-failed'
  | 'cancelled'
  | 'timeout'
  | 'blocked'
  | 'rate-limited'
  | 'user-closed'

export type DoubaoUserCloseOutcome = 'cancelled-before-submit' | 'submitted-pending-recovery'

/** 已确认提交或已经触发提交动作后关闭，都按待找回处理，优先避免重复提交。 */
export function classifyDoubaoUserClose(submitted: boolean, submitAttempted: boolean): DoubaoUserCloseOutcome {
  return submitted || submitAttempted ? 'submitted-pending-recovery' : 'cancelled-before-submit'
}

/** 上传等待需同时响应显式停止和用户关闭窗口，避免 Promise 悬挂锁死分镜页。 */
export function shouldAbortDoubaoUpload(cancelled: boolean, userClosed: boolean): boolean {
  return cancelled || userClosed
}

/** 只有明确取得本次视频 URL 才自动关闭；其他情况均显示并保留现场，由用户手动关闭。 */
export function shouldCloseDoubaoWindow(reason: DoubaoWindowTerminalReason): boolean {
  return reason === 'success'
}
