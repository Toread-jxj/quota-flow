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

/** 上传等待需同时响应显式停止和用户关闭窗口，避免 Promise 悬挂锁死分镜页。 */
export function shouldAbortDoubaoUpload(cancelled: boolean, userClosed: boolean): boolean {
  return cancelled || userClosed
}

/**
 * 页面一旦被用户关闭，当前页面操作立即结束等待。
 * 这只是窗口生命周期中断信号，不创建后台任务或额外业务状态。
 */
export function raceDoubaoOperationWithClose<T>(
  operation: Promise<T>,
  windowClosed: Promise<void>
): Promise<{ closed: true } | { closed: false; value: T }> {
  return Promise.race([
    operation.then((value) => ({ closed: false as const, value })),
    windowClosed.then(() => ({ closed: true as const }))
  ])
}

/** 只有明确取得本次视频 URL 才自动关闭；其他情况均显示并保留现场，由用户手动关闭。 */
export function shouldCloseDoubaoWindow(reason: DoubaoWindowTerminalReason): boolean {
  return reason === 'success'
}
