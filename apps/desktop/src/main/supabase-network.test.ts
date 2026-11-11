import { describe, expect, it, vi } from 'vitest'

const { electronFetch } = vi.hoisted(() => ({
  electronFetch: vi.fn<typeof fetch>()
}))

vi.mock('electron', () => ({
  net: { fetch: electronFetch }
}))

import { withElectronNet } from './supabase-network'

describe('withElectronNet', () => {
  it('让主进程 Supabase 客户端复用 Electron Chromium 网络栈', () => {
    const config = withElectronNet({
      supabaseUrl: 'https://example.test',
      supabaseAnonKey: 'anon-key'
    })

    expect(config.fetch).toBe(electronFetch)
  })
})
