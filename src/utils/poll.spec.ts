import { describe, expect, it } from 'vitest'

/**
 * 轮询节奏预算单测（D-6）。
 *
 * 这里的价值不在「函数算得对」，而在**把量纲冲突这件事钉成回归防护**：
 *  * 错的总额不会无限膨胀（有硬顶，否则轮询会被错峰停掉）；
 *  * 收敛必须有保底（不能退化成 0，否则丢弃了错峰的原始目的）；
 *  * 会话数 ≤1 时不该产生错峰（没有「之间」可言）。
 *
 * 注意这里**刻意不断言「总额一定 ≤ 间隔」** —— 那是物理上做不到的：
 * 100 个会话各保底 300ms 就要 29.7s。规则是「优先装进间隔，装不下时保底赢，
 * 但总额有硬顶」，单测要守住的是这台「取舍机器」的边界，不是一句漂亮话。
 */
import {
  POLL_STAGGER_MS,
  POLL_STAGGER_MIN_MS,
  POLL_STAGGER_TOTAL_MAX_MS,
  effectiveStaggerMs,
  planPollRound,
} from '@/utils/poll'

describe('utils/poll —— effectiveStaggerMs（错峰总额收敛到一轮间隔内）', () => {
  it('会话数 ≤ 1 时不排错峰（没有「之间」可言）', () => {
    expect(effectiveStaggerMs(5000, 1)).toBe(0)
    expect(effectiveStaggerMs(5000, 0)).toBe(0)
  })

  it('配置为 0 时完全关闭错峰（测试友好）', () => {
    expect(effectiveStaggerMs(5000, 20, 0)).toBe(0)
  })

  it('**装得下就用满配置**：3 个会话 + 5s 间隔 → 2s（不无谓收敛）', () => {
    // 预算 5000/2 = 2500 > 配置上限 2000 → 取 2000，且总额 4000 ≤ 5000
    expect(effectiveStaggerMs(5000, 3)).toBe(POLL_STAGGER_MS)
    expect(effectiveStaggerMs(5000, 3) * 2).toBeLessThanOrEqual(5000)
  })

  it('**装不下时向间隔收敛**：5 个会话 + 5s 间隔 → 总额压进 5s 内', () => {
    const perConv = effectiveStaggerMs(5000, 5)
    expect(perConv * 4).toBeLessThanOrEqual(5000)
    expect(perConv).toBeLessThan(POLL_STAGGER_MS)
  })

  it('**保底优先于间隔**：20 个会话 + 5s 间隔 → 取保底 300ms（进程风暴更糟）', () => {
    // 预算 5000/19 ≈ 263ms < 保底 300ms → 保底赢
    expect(effectiveStaggerMs(5000, 20)).toBe(POLL_STAGGER_MIN_MS)
  })

  it('**总额有硬顶**：1000 个会话不会把单轮错峰拖成几分钟', () => {
    const count = 1000
    const perConv = effectiveStaggerMs(5000, count)
    expect(perConv * (count - 1)).toBeLessThanOrEqual(POLL_STAGGER_TOTAL_MAX_MS + 1)
    expect(perConv).toBeGreaterThan(0)
  })

  it('**绝不为 0**（N > 1 时）：收敛不会退化成「没有错峰」', () => {
    expect(effectiveStaggerMs(3000, 100)).toBeGreaterThan(0)
    expect(effectiveStaggerMs(3000, 100, 200)).toBeGreaterThan(0)
  })

  it('保底不超过配置上限（配置 200ms 时保底跟着降到 200ms）', () => {
    expect(effectiveStaggerMs(3000, 100, 200)).toBe(200)
  })

  it('间隔越大预算越宽（隐藏窗口 ×3 后错峰同步放宽）', () => {
    expect(effectiveStaggerMs(15_000, 5)).toBeGreaterThan(effectiveStaggerMs(5000, 5))
  })

  it('返回整数毫秒（不产生 263.157... 这类值）', () => {
    expect(Number.isInteger(effectiveStaggerMs(5000, 4))).toBe(true)
  })
})

describe('utils/poll —— planPollRound（设置页的实际周期预估）', () => {
  it('无会话时周期等于间隔本身，且不标记收敛', () => {
    const plan = planPollRound({ intervalSec: 5, conversationCount: 0 })
    expect(plan.staggerMs).toBe(0)
    expect(plan.periodMs).toBe(5000)
    expect(plan.converged).toBe(false)
  })

  it('单会话不产生错峰也不标记收敛（无从「收敛」）', () => {
    const plan = planPollRound({ intervalSec: 5, conversationCount: 1 })
    expect(plan.staggerTotalMs).toBe(0)
    expect(plan.periodMs).toBe(5000)
    expect(plan.converged).toBe(false)
  })

  it('错峰总额计入周期（不是只显示「间隔」）', () => {
    // 3 个会话 → 每会话 2000 → 总额 4000
    const plan = planPollRound({ intervalSec: 5, conversationCount: 3 })
    expect(plan.staggerMs).toBe(POLL_STAGGER_MS)
    expect(plan.staggerTotalMs).toBe(4000)
    expect(plan.periodMs).toBe(9000)
  })

  it('**标记收敛**：会话多到需要收敛时为 true（UI 据此给出解释）', () => {
    expect(planPollRound({ intervalSec: 5, conversationCount: 20 }).converged).toBe(true)
    expect(planPollRound({ intervalSec: 5, conversationCount: 5 }).converged).toBe(true)
    expect(planPollRound({ intervalSec: 5, conversationCount: 3 }).converged).toBe(false)
  })

  it('关闭错峰时永不标记收敛', () => {
    const plan = planPollRound({ intervalSec: 5, conversationCount: 50, configuredStaggerMs: 0 })
    expect(plan.converged).toBe(false)
    expect(plan.periodMs).toBe(5000)
  })

  it('隐藏系数与退避系数都反映到周期上（与 poller 的 baseIntervalMs 同口径）', () => {
    const plan = planPollRound({ intervalSec: 5, conversationCount: 3, hiddenFactor: 3 })
    expect(plan.periodMs).toBe(15_000 + 4000)
    const withBackoff = planPollRound({ intervalSec: 5, conversationCount: 3, backoffFactor: 2 })
    expect(withBackoff.periodMs).toBe(10_000 + 4000)
  })

  it('会话数为负/小数时收敛为合法值（配置是手改 JSON，不可信）', () => {
    expect(planPollRound({ intervalSec: 5, conversationCount: -3 }).conversationCount).toBe(0)
    expect(planPollRound({ intervalSec: 5, conversationCount: 3.7 }).conversationCount).toBe(3)
  })
})
