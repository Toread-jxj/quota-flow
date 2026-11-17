import { describe, expect, it } from 'vitest'
import { summarizeDoubaoNetworkFailures } from './doubao-network-diagnostics'

describe('summarizeDoubaoNetworkFailures', () => {
  it('只保留分类、状态和传输错误，不泄露 URL', () => {
    expect(summarizeDoubaoNetworkFailures([
      { kind: 'upload', epoch: 1, status: 503 },
      { kind: 'submit', epoch: 1, transportError: true },
      { kind: 'other', epoch: 1, status: 200 }
    ])).toEqual([
      { kind: 'upload', status: 503, transportError: false },
      { kind: 'submit', status: null, transportError: true }
    ])
  })

  it('只接受当前操作 epoch，忽略清理前发起但清理后完成的旧请求', () => {
    expect(summarizeDoubaoNetworkFailures([
      { kind: 'upload', epoch: 1, status: 500 },
      { kind: 'upload', epoch: 2, status: 200 },
      { kind: 'submit', epoch: 2, transportError: true }
    ], { kind: 'upload', epoch: 2 })).toEqual([])

    expect(summarizeDoubaoNetworkFailures([
      { kind: 'upload', epoch: 1, status: 500 },
      { kind: 'upload', epoch: 2, status: 503 }
    ], { kind: 'upload', epoch: 2 })).toEqual([
      { kind: 'upload', status: 503, transportError: false }
    ])
  })
})
