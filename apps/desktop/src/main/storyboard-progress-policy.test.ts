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
})
