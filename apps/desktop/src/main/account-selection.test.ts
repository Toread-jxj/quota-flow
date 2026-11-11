import { describe, expect, it } from 'vitest'
import { findNextProviderAccount } from './account-selection'

type Key = { id: string }

const keys: Key[] = [{ id: 'low' }, { id: 'enough' }]

describe('findNextProviderAccount', () => {
  it('自动选号只选择剩余额度足够的账号', () => {
    const selected = findNextProviderAccount(keys, new Set(), (id) => (id === 'low' ? 5 : 30), 15, null)
    expect(selected?.id).toBe('enough')
  })

  it('手工指定账号时按人工授权忽略本地日额度上限', () => {
    const selected = findNextProviderAccount(keys, new Set(), () => 0, 15, 'low')
    expect(selected?.id).toBe('low')
  })
})
