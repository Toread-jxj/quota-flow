import { describe, expect, it } from 'vitest'
import { initializePromptDrafts, promptForGeneration, updatePromptDraft } from './storyboard-prompt-policy'

describe('storyboard prompt drafts', () => {
  const shots = [
    { index: 1, prompt: '来源提示词一' },
    { index: 2, prompt: '来源提示词二' }
  ]

  it('解析后以来源提示词初始化客户端草稿', () => {
    expect(initializePromptDrafts(shots)).toEqual({ 1: '来源提示词一', 2: '来源提示词二' })
  })

  it('只更新客户端草稿且不修改来源分镜对象', () => {
    const drafts = initializePromptDrafts(shots)
    const next = updatePromptDraft(drafts, 1, '客户端修改后的提示词')

    expect(next[1]).toBe('客户端修改后的提示词')
    expect(drafts[1]).toBe('来源提示词一')
    expect(shots[0].prompt).toBe('来源提示词一')
  })

  it('点击生成时优先使用最新客户端草稿', () => {
    const drafts = updatePromptDraft(initializePromptDrafts(shots), 1, '同步到豆包的最新提示词')
    expect(promptForGeneration(shots[0], drafts)).toBe('同步到豆包的最新提示词')
  })
})
