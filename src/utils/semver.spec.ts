import { describe, expect, it } from 'vitest'

import { compareSemVer, isStrictSemVer } from './semver'

describe('compareSemVer', () => {
  it('三段逐位比较：大于/小于/相等', () => {
    expect(compareSemVer('0.2.0', '0.1.0')).toBe(1)
    expect(compareSemVer('0.1.0', '0.2.0')).toBe(-1)
    expect(compareSemVer('1.0.0', '1.0.0')).toBe(0)
    // 逐位语义：patch 位比较不影响高位相同
    expect(compareSemVer('0.1.10', '0.1.9')).toBe(1)
    expect(compareSemVer('1.10.0', '1.9.99')).toBe(1)
  })

  it('空段/缺段/多段 → 0（视为无更新，更新域异常不得比「不更新」更糟）', () => {
    expect(compareSemVer('', '0.1.0')).toBe(0)
    expect(compareSemVer('0.1', '0.1.0')).toBe(0)
    expect(compareSemVer('0.1.0.0', '0.1.0')).toBe(0)
    expect(compareSemVer('0.1.0', '')).toBe(0)
  })

  it('非数字段/负数 → 0', () => {
    expect(compareSemVer('a.b.c', '0.0.0')).toBe(0)
    expect(compareSemVer('0.1.x', '0.1.2')).toBe(0)
    expect(compareSemVer('-1.0.0', '0.1.0')).toBe(0)
  })

  it('null/undefined 入参不抛异常并返回 0', () => {
    expect(compareSemVer(undefined as unknown as string, '0.1.0')).toBe(0)
    expect(compareSemVer('0.1.0', null as unknown as string)).toBe(0)
  })

  it('前后空白可容忍（清单 version 可能带空格）', () => {
    expect(compareSemVer(' 0.2.0 ', '0.1.0')).toBe(1)
  })
})

describe('isStrictSemVer', () => {
  it('严格 x.y.z 通过，其余拒绝', () => {
    expect(isStrictSemVer('0.1.0')).toBe(true)
    expect(isStrictSemVer('10.20.30')).toBe(true)
    expect(isStrictSemVer('v0.1.0')).toBe(false)
    expect(isStrictSemVer('0.1')).toBe(false)
    expect(isStrictSemVer('0.1.0-beta')).toBe(false)
    expect(isStrictSemVer('')).toBe(false)
  })
})
