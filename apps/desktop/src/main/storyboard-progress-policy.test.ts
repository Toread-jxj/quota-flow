import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { validateStoryboardProgressRoot } from './storyboard-progress-policy'

describe('validateStoryboardProgressRoot', () => {
  it('接受普通对象和普通 shots 对象', () => {
    expect(validateStoryboardProgressRoot({ shots: { '1': { status: 'done' } } })).toEqual({ ok: true })
    expect(validateStoryboardProgressRoot({})).toEqual({ ok: true })
  })

  it('拒绝数组或非对象顶层', () => {
    expect(validateStoryboardProgressRoot([]).ok).toBe(false)
    expect(validateStoryboardProgressRoot(null).ok).toBe(false)
    expect(validateStoryboardProgressRoot('bad').ok).toBe(false)
  })

  it('拒绝数组或非对象 shots', () => {
    expect(validateStoryboardProgressRoot({ shots: [] }).ok).toBe(false)
    expect(validateStoryboardProgressRoot({ shots: 'bad' }).ok).toBe(false)
  })

  it('拒绝非对象 shot 条目和错误字段类型', () => {
    expect(validateStoryboardProgressRoot({ shots: { '1': 'bad' } }).ok).toBe(false)
    expect(validateStoryboardProgressRoot({ shots: { '1': [] } }).ok).toBe(false)
    expect(validateStoryboardProgressRoot({ shots: { '1': null } }).ok).toBe(false)
    expect(validateStoryboardProgressRoot({ shots: { '1': { status: 1 } } }).ok).toBe(false)
    expect(validateStoryboardProgressRoot({ shots: { '1': { jobId: 2 } } }).ok).toBe(false)
  })

  it('分镜生成选中实际账号时必须立即持久化 jobId 和 accountId', () => {
    const text = readFileSync(resolve(process.cwd(), 'src/main/index.ts'), 'utf8')
    const start = text.indexOf("'storyboard:generate'")
    const end = text.indexOf("ipcMain.handle('storyboard:diagnostics-path'", start)
    const block = text.slice(start, end)
    expect(block).toContain("event.stage !== 'select-account'")
    expect(block).toContain('jobId: event.jobId')
    expect(block).toContain('accountId')
    expect(block).toContain("status: 'running'")
    expect(block).toContain('currentProgress.accountId')
    expect(block).toContain('currentProgress.jobId')
  })
})
