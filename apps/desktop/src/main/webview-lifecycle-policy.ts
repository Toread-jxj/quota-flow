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

/** 只有明确取得本次视频 URL 才自动关闭；其他情况均显示并保留现场，由用户手动关闭。 */
export function shouldCloseDoubaoWindow(reason: DoubaoWindowTerminalReason): boolean {
  return reason === 'success'
}
