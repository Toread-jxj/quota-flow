import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DEFAULT_DOUBAO_MODEL, MODELS } from './spec'

function source(relativePath: string): string {
  return readFileSync(resolve(process.cwd(), 'src/renderer/src', relativePath), 'utf8')
}

describe('豆包默认模型', () => {
  it('默认使用 Seedance 2.0 Fast，并保留 Mini 手动选项', () => {
    expect(DEFAULT_DOUBAO_MODEL).toBe('Seedance 2.0 Fast')
    expect(MODELS.doubao).toEqual(['Seedance 2.0 Fast', 'Seedance 2.0 Mini'])
  })

  it('普通生成、创作中心和分镜入口复用同一个默认模型常量', () => {
    expect(source('components/Dashboard.tsx')).toContain(
      'useState(DEFAULT_DOUBAO_MODEL)'
    )
    expect(source('components/CreationCenter.tsx')).toContain(
      'model: DEFAULT_DOUBAO_MODEL'
    )
    expect(source('components/StoryboardEditor.tsx')).toContain(
      'model: DEFAULT_DOUBAO_MODEL'
    )
  })
})