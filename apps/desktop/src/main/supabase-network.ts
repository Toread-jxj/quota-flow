import { net } from 'electron'
import type { SupabaseConfig } from '@quota-flow/db-supabase'

/**
 * Electron 主进程中的 Supabase 请求统一复用 Chromium 网络栈。
 * 这样登录/列表（renderer）与生成调度（main）遵守同一套系统代理、证书和分流规则。
 */
export function withElectronNet(config: SupabaseConfig): SupabaseConfig {
  return { ...config, fetch: net.fetch as typeof fetch }
}
