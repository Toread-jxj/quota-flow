import { describe, expect, it } from 'vitest'
import { hasConfirmRequestAfterPrompt } from './confirm-request-policy'

describe('hasConfirmRequestAfterPrompt', () => {
  it('忽略本次完整提示词之前的历史确认文案', () => {
    const prompt = '本次镜头内容，角色向前走'
    expect(hasConfirmRequestAfterPrompt(`确认以上参数\n历史内容\n${prompt}`, prompt)).toBe(false)
  })

  it('只识别本次完整提示词之后出现的确认请求', () => {
    const prompt = '本次镜头内容，角色向前走'
    expect(hasConfirmRequestAfterPrompt(`历史确认以上参数\n${prompt}\n请确认以上方案`, prompt)).toBe(true)
  })

  it('提示词正文自身含确认关键词时不触发确认', () => {
    const prompt = '角色阅读屏幕文字：请确认以上方案，然后继续向前走'
    expect(hasConfirmRequestAfterPrompt(`历史内容\n${prompt}`, prompt)).toBe(false)
  })

  it('找不到本次完整提示词时不触发确认', () => {
    expect(hasConfirmRequestAfterPrompt('确认以上参数', '本次镜头内容')).toBe(false)
  })
})
