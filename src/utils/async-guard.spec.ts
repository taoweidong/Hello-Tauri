import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { foldRejection, withHardTimeout } from './async-guard'

describe('withHardTimeout', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('任务在预算内完成：透传成功值', async () => {
    const pending = withHardTimeout(async () => 'ok', 1000, () => 'timeout')
    await vi.advanceTimersByTimeAsync(10)
    await expect(pending).resolves.toBe('ok')
  })

  it('任务挂死：预算到达后确定性 resolve onTimeout 结果', async () => {
    const pending = withHardTimeout(
      () => new Promise<string>(() => {}),
      1000,
      () => 'timeout-fallback',
    )
    const assertion = expect(pending).resolves.toBe('timeout-fallback')
    await vi.advanceTimersByTimeAsync(1001)
    await assertion
  })

  it('rejection 原样传播（通道故障语义归调用方）', async () => {
    const pending = withHardTimeout(
      async () => {
        throw new Error('通道故障')
      },
      1000,
      () => 'timeout-fallback',
    )
    await expect(pending).rejects.toThrow('通道故障')
  })

  it('settle 后定时器必须清除（含超时路径与成功路径）', async () => {
    await withHardTimeout(async () => 'ok', 1000, () => 'x')
    expect(vi.getTimerCount()).toBe(0)

    const hung = withHardTimeout(
      () => new Promise<string>(() => {}),
      1000,
      () => 'x',
    )
    const assertion = expect(hung).resolves.toBe('x')
    await vi.advanceTimersByTimeAsync(1001)
    await assertion
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('foldRejection', () => {
  it('成功值原样透传', async () => {
    await expect(foldRejection(async () => 42, () => -1)).resolves.toBe(42)
  })

  it('rejection 折叠为 onFailure 结果，包装后永不 reject', async () => {
    const folded = foldRejection(
      async () => {
        throw new Error('宿主契约违约')
      },
      (error) => ({ ok: false, detail: String(error) }),
    )
    await expect(folded).resolves.toEqual({ ok: false, detail: 'Error: 宿主契约违约' })
  })
})
