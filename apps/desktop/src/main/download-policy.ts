export type DownloadRedirectDecision =
  | { ok: true; url: string }
  | { ok: false; reason: string }

export function resolveDownloadRedirect(currentUrl: string, location: string): DownloadRedirectDecision {
  try {
    const next = new URL(location, currentUrl)
    if (next.protocol !== 'https:') {
      return { ok: false, reason: `不支持的重定向协议：${next.protocol}` }
    }
    return { ok: true, url: next.toString() }
  } catch (error) {
    return { ok: false, reason: `无效重定向地址：${error instanceof Error ? error.message : String(error)}` }
  }
}
