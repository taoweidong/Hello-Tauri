import { describe, expect, it } from 'vitest'

import { clockStamp, formatMs, formatSec, isMuted, muteLabel, shortStamp } from './welink-display'

/**
 * T-4：展示层纯函数的单测。
 *
 * 重点不在「函数能跑」，而在**钉住抽取前两处实现互相矛盾的那些点** ——
 * 这些用例就是「口径已统一」的证据。
 */

describe('utils/welink-display —— 时间戳格式化', () => {
  it('shortStamp 取 MM-DD HH:mm', () => {
    expect(shortStamp('2026-09-28 10:30:45')).toBe('09-28 10:30')
  })

  it('shortStamp 空值给 fallback（默认 -，不再是各页面各写一个）', () => {
    expect(shortStamp(null)).toBe('-')
    expect(shortStamp('')).toBe('-')
    expect(shortStamp(undefined)).toBe('-')
    expect(shortStamp('', '')).toBe('')
  })

  it('clockStamp 取 HH:mm', () => {
    expect(clockStamp('2026-09-28 10:30:45')).toBe('10:30')
  })

  it('clockStamp 空值给 fallback', () => {
    expect(clockStamp(null)).toBe('-')
  })
})

describe('utils/welink-display —— 静音剩余（O11）', () => {
  const now = new Date(2026, 8, 28, 10, 0, 0) // 2026-09-28 10:00

  it('未来时间点 → 静音至 MM-DD HH:mm', () => {
    expect(muteLabel('2026-09-28 18:00:00', now)).toBe('静音至 09-28 18:00')
  })

  it('withDate=false → 只给 HH:mm', () => {
    expect(muteLabel('2026-09-28 18:00:00', now, false)).toBe('静音至 18:00')
  })

  it('**已到期返回空串**（抽取前 MessagesTab 用字符串比较、ConfigTab 用日期解析）', () => {
    expect(muteLabel('2026-09-28 09:59:59', now)).toBe('')
    // 恰好等于当前时刻也算到期：静音已结束
    expect(muteLabel('2026-09-28 10:00:00', now)).toBe('')
  })

  it('未静音（null / 空串 / 非法格式）一律空串，且不抛错', () => {
    expect(muteLabel(null, now)).toBe('')
    expect(muteLabel('', now)).toBe('')
    expect(muteLabel('不是时间', now)).toBe('')
  })

  it('**静音状态与文案单一判据**：isMuted 与 muteLabel 必须一致', () => {
    expect(isMuted('2026-09-28 18:00:00', now)).toBe(true)
    expect(isMuted('2026-09-28 09:00:00', now)).toBe(false)
    expect(isMuted(null, now)).toBe(false)
    // 断言两者的派生关系，防止将来有人只改其中一个
    const future = '2026-09-28 18:00:00'
    const past = '2026-09-28 09:00:00'
    expect(isMuted(future, now)).toBe(muteLabel(future, now) !== '')
    expect(isMuted(past, now)).toBe(muteLabel(past, now) !== '')
  })

  it('跨天静音也按日期正确判定（不是只比 HH:mm）', () => {
    expect(muteLabel('2026-09-29 08:00:00', now)).toBe('静音至 09-29 08:00')
    expect(muteLabel('2026-09-27 08:00:00', now)).toBe('')
  })
})

describe('utils/welink-display —— 时长格式化', () => {
  it('formatMs：<1s 用毫秒，整秒不带小数，非整秒保留一位', () => {
    expect(formatMs(300)).toBe('300ms')
    expect(formatMs(2000)).toBe('2s')
    expect(formatMs(1500)).toBe('1.5s')
    expect(formatMs(0)).toBe('0ms')
  })

  it('formatSec：秒保留一位小数（避免 40.0000001 这类浮点噪音）', () => {
    expect(formatSec(5000)).toBe('5.0s')
    expect(formatSec(40_000)).toBe('40.0s')
    expect(formatSec(1_234)).toBe('1.2s')
  })
})
