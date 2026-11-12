import { describe, expect, it } from 'vitest'
import { pickNewVideoResult } from './video-result-policy'

describe('pickNewVideoResult', () => {
  it('baseline 未成功采集时绝不把页面视频认作本次结果', () => {
    expect(pickNewVideoResult(false, new Set(), [{ src: 'old.mp4' }], ['old.mp4'])).toBeNull()
  })

  it('baseline 成功时只返回不在历史集合中的新增视频', () => {
    const baseline = new Set(['old.mp4'])
    expect(pickNewVideoResult(true, baseline, [{ src: 'old.mp4' }, { src: 'new.mp4', poster: 'p.jpg' }], []))
      .toEqual({ videoUrl: 'new.mp4', posterUrl: 'p.jpg' })
  })

  it('页面只有历史视频时不返回结果', () => {
    expect(pickNewVideoResult(true, new Set(['old.mp4']), [{ src: 'old.mp4' }], ['old.mp4'])).toBeNull()
  })
})
