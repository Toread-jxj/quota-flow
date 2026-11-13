import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parseStoryboardText } from './storyboard'

const oldFormat = `# 《旧格式》全剧分镜提示词

## V001｜旧格式第一段｜00:00—00:15

【场景】
@AS_L01_旧场景

【固定镜头1｜0.00—5.00秒】
动作：
角色A走到桌边，
拿起桌上的杯子。
表演触发：角色A确认杯子仍有余温。

【固定镜头2｜5.00—15.00秒】
动作：角色B抬头回应。

【对白】
｜ROLE_A｜：“Old line.”
`

const newFormat = `# 《新格式》｜全片2段分镜提示词

## 使用与当前状态
说明文字不属于生成任务。

## PLAN1｜制作状态
这个带字母数字编号的说明标题也不属于生成任务。

## E01-V01｜新格式第一段｜00:00—00:15｜15秒

#### 【场景】
@AS_L01_新场景

#### 【固定镜头1｜0.00—6.00秒】
动作链：角色A收回票据。

#### 【固定镜头2｜6.00—15.00秒】
动作链：角色B松手并回应。

#### 【C层｜正式英文对白及发声时间】
- D001｜0.20—2.80秒｜MAYA：First new line.
- D002｜6.20—8.80秒｜NOAH：Second new line.

## E01-V02｜新格式第二段｜00:15—00:30｜15秒

#### 【场景】
@AS_L02_新场景

#### 【固定镜头1｜0.00—15.00秒】
动作链：角色A指出样稿上的名字。

#### 【C层｜正式英文对白及发声时间】
- D003｜1.00—4.00秒｜MAYA：Third new line.
`

describe('parseStoryboardText', () => {
  it('保留旧 V001 三字段格式的解析行为', () => {
    const shots = parseStoryboardText(oldFormat)
    expect(shots).toHaveLength(1)
    expect(shots[0]).toMatchObject({
      id: 'V001',
      title: '旧格式第一段',
      durationSec: 15,
      actions: ['角色A走到桌边，\n拿起桌上的杯子', '角色B抬头回应']
    })
    expect(shots[0].dialogue).toEqual([{ role: 'ROLE_A', line: 'Old line.' }])
  })

  it('兼容 E01-V01 四字段格式且忽略前置说明章节', () => {
    const shots = parseStoryboardText(newFormat)
    expect(shots).toHaveLength(2)
    expect(shots.map((shot) => shot.id)).toEqual(['E01-V01', 'E01-V02'])
    expect(shots.map((shot) => shot.durationSec)).toEqual([15, 15])
  })

  it('兼容动作链字段和新式对白行', () => {
    const shots = parseStoryboardText(newFormat)
    expect(shots[0].actions).toEqual(['角色A收回票据', '角色B松手并回应'])
    expect(shots[0].dialogue).toEqual([
      { role: 'MAYA', line: 'First new line.' },
      { role: 'NOAH', line: 'Second new line.' }
    ])
    expect(shots[1].actions).toEqual(['角色A指出样稿上的名字'])
    expect(shots[1].dialogue).toEqual([{ role: 'MAYA', line: 'Third new line.' }])
  })

  it('每个 E01-Vxx 段仍只形成一个生成任务，不按内部镜头拆分', () => {
    const shots = parseStoryboardText(newFormat)
    expect(shots).toHaveLength(2)
    expect(shots[0].prompt).toContain('【固定镜头1｜0.00—6.00秒】')
    expect(shots[0].prompt).toContain('【固定镜头2｜6.00—15.00秒】')
  })

  it('内部镜头识别异常时仍以分段标题总时长同步到 15 秒档', () => {
    const text = `## V012｜汤姆的求婚｜全片02:45—03:00.54

【A层｜项目、版本与生成任务】本视频15.54秒，内含四固定镜头，不拆称四次生成。

【固定镜头一｜0.00—2.13秒】动作已完成。
【固定镜头二｜2.13—9.29秒】继续播放。
【固定镜头三｜9.29—13.41秒】人物聆听。
【固定镜头四｜13.41—15.54秒】保持末态。
`
    const shots = parseStoryboardText(text)
    expect(shots).toHaveLength(1)
    expect(shots[0]).toMatchObject({ id: 'V012', durationSec: 15 })
  })

  it('完整量产文件解析为43个任务且每段保留4个内部镜头', () => {
    const fixture = process.env.QF_STORYBOARD_FIXTURE
    if (!fixture) return
    const shots = parseStoryboardText(readFileSync(fixture, 'utf8'))
    expect(shots).toHaveLength(43)
    expect(shots[0]).toMatchObject({ id: 'E01-V01', title: '收回私人邀请', durationSec: 15 })
    expect(shots[42].id).toBe('E01-V43')
    for (const shot of shots) {
      expect(shot.actions).toHaveLength(4)
      expect(shot.actions.every(Boolean)).toBe(true)
      expect(shot.prompt.match(/【[^】]*镜头\d+[^】]*】/g)).toHaveLength(4)
    }
  })
})
