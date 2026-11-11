import { describe, expect, it, vi } from 'vitest'

const { getPathMock } = vi.hoisted(() => ({ getPathMock: vi.fn(() => '/tmp/qf-test') }))
vi.mock('electron', () => ({ app: { getPath: getPathMock } }))

import { logGeneration } from './diagnostics'

describe('generation diagnostics', () => {
  it('exports a structured log writer', () => {
    expect(typeof logGeneration).toBe('function')
  })
})
