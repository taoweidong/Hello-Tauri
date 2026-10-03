import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { realTimers } from './timers'

describe('realTimers（假时钟下可断言的定时器抽象）', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('set：延迟到期后执行一次', () => {
    const handler = vi.fn()
    realTimers.set(handler, 500)
    expect(handler).not.toHaveBeenCalled()
    vi.advanceTimersByTime(500)
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it('clear：句柄取消后不再执行', () => {
    const handler = vi.fn()
    const id = realTimers.set(handler, 500)
    realTimers.clear(id)
    vi.advanceTimersByTime(1000)
    expect(handler).not.toHaveBeenCalled()
  })

  it('负延迟钳到 0（立即执行，不抛错）', () => {
    const handler = vi.fn()
    realTimers.set(handler, -100)
    vi.advanceTimersByTime(0)
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it('clear 容忍 null/undefined 句柄（poller 的重建路径）', () => {
    expect(() => realTimers.clear(null)).not.toThrow()
    expect(() => realTimers.clear(undefined)).not.toThrow()
  })
})
