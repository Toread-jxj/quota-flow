import { describe, expect, it, vi } from 'vitest'

const { getPathMock } = vi.hoisted(() => ({
  getPathMock: vi.fn((name: string) => name === 'exe' ? '/opt/quota-flow/Quota-Flow.exe' : '/tmp/qf-test')
}))
vi.mock('electron', () => ({ app: { getPath: getPathMock } }))

import { logGeneration, resolveGenerationLogPath } from './diagnostics'

describe('generation diagnostics', () => {
  it('exports a structured log writer', () => {
    expect(typeof logGeneration).toBe('function')
  })

  it('stores the Windows generation log beside the executable', () => {
    expect(resolveGenerationLogPath('win32', 'C:\\Quota-Flow\\Quota-Flow.exe', 'C:\\Users\\tester\\AppData\\Roaming\\Quota-Flow'))
      .toBe('C:\\Quota-Flow\\qf-generation.log')
  })

  it('keeps non-Windows logs in userData', () => {
    expect(resolveGenerationLogPath('linux', '/opt/quota-flow/quota-flow', '/home/tester/.config/Quota-Flow'))
      .toBe('/home/tester/.config/Quota-Flow/qf-generation.log')
  })
})
