import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

function source(): string {
  return readFileSync(resolve(process.cwd(), 'src/main/providers.ts'), 'utf8')
}

describe('厂商健康检查窗口生命周期', () => {
  it('隐藏健康检查窗口超时销毁后，迟到的加载完成事件不得访问已销毁的 WebContents', () => {
    const text = source()
    const healthStart = text.indexOf('async function healthCheck')
    const finishLoad = text.indexOf("win.webContents.on('did-finish-load'", healthStart)
    const getUrl = text.indexOf('finalUrl = win.webContents.getURL()', finishLoad)

    expect(healthStart).toBeGreaterThan(-1)
    expect(finishLoad).toBeGreaterThan(healthStart)
    expect(getUrl).toBeGreaterThan(finishLoad)
    expect(text.slice(finishLoad, getUrl)).toContain(
      'if (win.isDestroyed() || win.webContents.isDestroyed()) return'
    )
  })
})
