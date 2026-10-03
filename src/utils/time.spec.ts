import { describe, expect, it } from 'vitest'

import { clock, diffMs, hourBucket, isOlderThan, nowStamp, parseStamp, today } from './time'

describe('time：本地时间工具（UTC 陷阱的守卫）', () => {
  it('nowStamp 按本地时间拼字符串（东八区凌晨不把今天记成昨天）', () => {
    // 本地 2026-09-27 23:48:14（用本地分量构造，规避测试机的时区差异）
    const date = new Date(2026, 8, 27, 23, 48, 14)
    expect(nowStamp(date)).toBe('2026-09-27 23:48:14')
  })

  it('today / clock 是 nowStamp 的切片', () => {
    const date = new Date(2026, 0, 3, 7, 5, 9)
    expect(today(date)).toBe('2026-01-03')
    expect(clock(date)).toBe('07:05')
  })

  it('parseStamp：标准格式解析为本地 Date；空/非法返回 null 而不抛', () => {
    const parsed = parseStamp('2026-09-27 23:48:14')
    expect(parsed).toEqual(new Date(2026, 8, 27, 23, 48, 14))
    expect(parseStamp('2026-09-27T23:48:14')).toEqual(new Date(2026, 8, 27, 23, 48, 14))
    expect(parseStamp('')).toBeNull()
    expect(parseStamp(null)).toBeNull()
    expect(parseStamp('not-a-stamp')).toBeNull()
  })

  it('diffMs：正常差值；任一端不可解析回退 fallback', () => {
    expect(diffMs('2026-09-27 10:00:00', '2026-09-27 10:01:30')).toBe(90_000)
    expect(diffMs(null, '2026-09-27 10:00:00', -1)).toBe(-1)
    expect(diffMs('2026-09-27 10:00:00', 'garbage', 42)).toBe(42)
  })

  it('isOlderThan：超龄 true；未超龄/不可解析 false（草稿 4h 判定的语义）', () => {
    const now = new Date(2026, 8, 27, 12, 0, 0)
    expect(isOlderThan('2026-09-27 07:00:00', 4 * 3600_000, now)).toBe(true)
    expect(isOlderThan('2026-09-27 09:00:00', 4 * 3600_000, now)).toBe(false)
    expect(isOlderThan(null, 4 * 3600_000, now)).toBe(false)
  })

  it('hourBucket：按小时分组的键', () => {
    expect(hourBucket('2026-09-27 14:22:31')).toBe('2026-09-27 14')
  })
})
