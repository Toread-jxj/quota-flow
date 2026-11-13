import { describe, expect, it } from 'vitest'
import { buildStoryboardAccountOption } from './storyboard-account-policy'

describe('buildStoryboardAccountOption', () => {
  it('豆包失效账号仍允许手动选择并标记为待网页验证', () => {
    expect(
      buildStoryboardAccountOption({
        keyId: 'account-1',
        accountName: '豆包账号 1',
        remaining: 120,
        health: 'expired'
      })
    ).toEqual({
      value: 'account-1',
      label: '豆包账号 1（剩 120秒）｜待网页验证',
      disabled: false
    })
  })

  it('即将过期账号保留提示且仍可选择', () => {
    expect(
      buildStoryboardAccountOption({
        keyId: 'account-2',
        accountName: '豆包账号 2',
        remaining: 60,
        health: 'expiring'
      })
    ).toEqual({
      value: 'account-2',
      label: '豆包账号 2（剩 60秒）｜即将过期',
      disabled: false
    })
  })
})
