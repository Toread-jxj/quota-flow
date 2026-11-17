import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  advanceDoubaoUploadReadiness,
  isDoubaoUploadReadyAfterGrace
} from './doubao-upload-readiness-policy'

function source(): string {
  return readFileSync(resolve(process.cwd(), 'src/main/webview-engine.ts'), 'utf8')
}

describe('豆包图片上传就绪门禁', () => {
  it('最短等待时间未满足时不会累计稳定采样', () => {
    expect(advanceDoubaoUploadReadiness(
      { stableClearSamples: 2 },
      { minimumWaitElapsed: false, pending: false, acceptedFileCount: 1, expectedFileCount: 1 }
    )).toEqual({ stableClearSamples: 0, shouldFinalCheck: false })
  })

  it('上传状态重新出现或文件数不符时会清零稳定采样', () => {
    expect(advanceDoubaoUploadReadiness(
      { stableClearSamples: 2 },
      { minimumWaitElapsed: true, pending: true, acceptedFileCount: 1, expectedFileCount: 1 }
    )).toEqual({ stableClearSamples: 0, shouldFinalCheck: false })

    expect(advanceDoubaoUploadReadiness(
      { stableClearSamples: 2 },
      { minimumWaitElapsed: true, pending: false, acceptedFileCount: 0, expectedFileCount: 1 }
    )).toEqual({ stableClearSamples: 0, shouldFinalCheck: false })
  })

  it('只有连续三次稳定采样后才允许进入最终复检', () => {
    const input = { minimumWaitElapsed: true, pending: false, acceptedFileCount: 1, expectedFileCount: 1 }
    const first = advanceDoubaoUploadReadiness({ stableClearSamples: 0 }, input)
    const second = advanceDoubaoUploadReadiness(first, input)
    const third = advanceDoubaoUploadReadiness(second, input)

    expect(first).toEqual({ stableClearSamples: 1, shouldFinalCheck: false })
    expect(second).toEqual({ stableClearSamples: 2, shouldFinalCheck: false })
    expect(third).toEqual({ stableClearSamples: 3, shouldFinalCheck: true })
  })

  it('额外等待后的复检必须同时满足无处理中状态和文件数一致', () => {
    expect(isDoubaoUploadReadyAfterGrace(false, 1, 1)).toBe(true)
    expect(isDoubaoUploadReadyAfterGrace(true, 1, 1)).toBe(false)
    expect(isDoubaoUploadReadyAfterGrace(false, 0, 1)).toBe(false)
  })

  it('上传失败或未确认完成时，主流程不得进入提示词提交分支', () => {
    const text = source()
    const uploadGuard = text.indexOf("if (!uploadOk) {")
    const submitBranch = text.indexOf("insertPromptAndSubmitScript.toString()")
    expect(uploadGuard).toBeGreaterThan(-1)
    expect(submitBranch).toBeGreaterThan(uploadGuard)
    expect(text.slice(uploadGuard, submitBranch)).toContain("return fail('图片上传失败")
  })

  it('二次确认回复只在明确检测到豆包确认请求后发送', () => {
    const text = source()
    expect(text).toContain('needConfirm = hasConfirmRequestAfterPrompt(pageText, submitPrompt)')
    expect(text).toContain('if (needConfirm && !confirmRequested)')
  })
})
