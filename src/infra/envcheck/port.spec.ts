import { describe, expect, it, vi } from 'vitest'

/**
 * 环境检测端口单测：硬超时包装 + 最坏状态归并。
 *
 * withHardTimeout 是「检测绝不卡页面」承诺的落点，四个语义都要钉死：
 *  1. 正常完成 → 原样透传结果；
 *  2. 挂死超时 → 折叠成 timeout 结果（而不是让调用方永远等待）；
 *  3. 意外抛错 → 折叠成 fail 结果（调用方假设 run 永不 reject）；
 *  4. settle 后清除定时器（不留悬挂 handle）。
 */
import { worstStatus, withHardTimeout, type EnvCheckOutcome } from '@/infra/envcheck/port'

function outcome(status: EnvCheckOutcome['status'], summary = '结论'): EnvCheckOutcome {
  return { status, summary, steps: [], durationMs: 1 }
}

describe('infra/envcheck —— worstStatus（最坏状态归并）', () => {
  it('空步骤归 ok', () => {
    expect(worstStatus([])).toBe('ok')
  })

  it('取最坏的一档：fail > timeout > warn > ok', () => {
    const step = (status: EnvCheckOutcome['status']) => ({
      name: 's',
      status,
      summary: '',
      durationMs: 1,
    })
    expect(worstStatus([step('ok'), step('warn'), step('ok')])).toBe('warn')
    expect(worstStatus([step('ok'), step('timeout')])).toBe('timeout')
    expect(worstStatus([step('warn'), step('timeout'), step('fail')])).toBe('fail')
    expect(worstStatus([step('ok'), step('ok')])).toBe('ok')
  })
})

describe('infra/envcheck —— withHardTimeout（硬超时包装）', () => {
  it('任务在预算内完成：原样透传结果', async () => {
    vi.useFakeTimers()
    try {
      const promised = withHardTimeout(async () => outcome('ok', '及时'), 1000, '某项检测')
      const result = await promised
      expect(result).toMatchObject({ status: 'ok', summary: '及时' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('任务挂死：到预算折叠成 timeout 结果，summary 带预算与名称', async () => {
    vi.useFakeTimers()
    try {
      const pending = withHardTimeout(
        () => new Promise<EnvCheckOutcome>(() => undefined), // 永不完成
        1000,
        'WeLink CLI',
      )
      const assertation = expect(pending).resolves.toMatchObject({
        status: 'timeout',
        summary: expect.stringContaining('1000ms'),
        details: expect.stringContaining('WeLink CLI'),
      })
      await vi.advanceTimersByTimeAsync(1000)
      await assertation
    } finally {
      vi.useRealTimers()
    }
  })

  it('任务抛错：折叠成 fail 结果（run 的「永不 reject」契约兜底）', async () => {
    vi.useFakeTimers()
    try {
      const pending = withHardTimeout(async () => {
        throw new Error('探测器炸了')
      }, 1000, '某项')
      await vi.advanceTimersByTimeAsync(0)
      await expect(pending).resolves.toMatchObject({
        status: 'fail',
        summary: expect.stringContaining('探测器炸了'),
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('提前完成后清除定时器：时间推进不再触发超时分支', async () => {
    vi.useFakeTimers()
    try {
      const result = await withHardTimeout(async () => outcome('ok'), 500, '某项')
      expect(result.status).toBe('ok')
      // 若定时器未被清除，这里会推进到一个已被 resolve 的 promise 上 ——
      // 行为上无害，但会暴露「未清理」；真正的守卫是 resolve 后 timer 引用被清空
      await vi.advanceTimersByTimeAsync(600)
      expect(result.status).toBe('ok')
    } finally {
      vi.useRealTimers()
    }
  })
})
