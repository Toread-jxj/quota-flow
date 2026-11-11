import { beforeEach, describe, expect, it, vi } from 'vitest'

const { createClientMock } = vi.hoisted(() => ({
  createClientMock: vi.fn(() => ({}) as never)
}))

vi.mock('@supabase/supabase-js', () => ({
  createClient: createClientMock
}))

import { createSupabaseClient } from './index'

describe('createSupabaseClient', () => {
  beforeEach(() => createClientMock.mockClear())

  it('把调用方提供的 fetch 传给 supabase-js，允许 Electron 主进程复用 Chromium 网络栈', () => {
    const customFetch = vi.fn<typeof fetch>()

    createSupabaseClient({
      supabaseUrl: 'https://example.test',
      supabaseAnonKey: 'anon-key',
      fetch: customFetch
    })

    expect(createClientMock).toHaveBeenCalledWith(
      'https://example.test',
      'anon-key',
      expect.objectContaining({
        global: { fetch: customFetch }
      })
    )
  })
})
