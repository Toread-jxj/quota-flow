export interface DoubaoUploadReadinessState {
  stableClearSamples: number
}

export interface DoubaoUploadReadinessInput {
  minimumWaitElapsed: boolean
  pending: boolean
  acceptedFileCount: number
  expectedFileCount: number
}

export interface DoubaoUploadReadinessDecision extends DoubaoUploadReadinessState {
  shouldFinalCheck: boolean
}

/**
 * 豆包图片上传的稳定采样门禁。
 *
 * 该函数会被序列化后注入 WebView，因此必须保持为无外部依赖的纯函数。
 */
export function advanceDoubaoUploadReadiness(
  state: DoubaoUploadReadinessState,
  input: DoubaoUploadReadinessInput
): DoubaoUploadReadinessDecision {
  if (
    !input.minimumWaitElapsed ||
    input.pending ||
    input.acceptedFileCount !== input.expectedFileCount
  ) {
    return { stableClearSamples: 0, shouldFinalCheck: false }
  }

  const stableClearSamples = state.stableClearSamples + 1
  return {
    stableClearSamples,
    shouldFinalCheck: stableClearSamples >= 3
  }
}

/** 额外等待后必须再次确认状态和文件数，防止短暂文案空窗。 */
export function isDoubaoUploadReadyAfterGrace(
  pending: boolean,
  acceptedFileCount: number,
  expectedFileCount: number
): boolean {
  return !pending && acceptedFileCount === expectedFileCount
}
