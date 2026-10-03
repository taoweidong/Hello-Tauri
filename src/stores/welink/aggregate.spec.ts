import { describe, expect, it } from 'vitest'

import type { SafetySnapshot } from '@/orchestrator/events'
import type { WelinkConversation, WelinkJob, WelinkMessage } from '@/types/welink'
import {
  applyJobStatusPatch,
  derivePollPlan,
  holdLabelOf,
  mergeTimelinePage,
  quotaTextOf,
  skipLabelOf,
  sortWatchingDesc,
  sourceBadgeOf,
  statusLabelOf,
  statusTextOf,
  unreadTotalOf,
  upsertSortedConvJob,
} from './aggregate'

function msg(pk: number, msgUid: string, sentAt: string, direction: 'in' | 'out' = 'in'): WelinkMessage {
  return { pk, msgUid, sentAt, direction } as WelinkMessage
}

function job(pk: number, overrides: Partial<WelinkJob> = {}): WelinkJob {
  return {
    pk,
    targetId: 'G-1',
    status: 'pending',
    holdReason: '',
    createdAt: '2026-10-02 10:00:00',
    updatedAt: '',
    ...overrides,
  } as WelinkJob
}

function conv(watching: boolean, lastMsgAt = '', pk = 1): WelinkConversation {
  return {
    pk,
    convId: `G-${pk}`,
    watching,
    unreadCount: pk,
    lastMsgAt,
  } as WelinkConversation
}

describe('aggregate.mergeTimelinePage', () => {
  it('按 msgUid 去重（发送回显与拉取重复不双行）', () => {
    const existing = [msg(1, 'u1', '10:00')]
    const fresh = [msg(1, 'u1', '10:00'), msg(2, 'u2', '10:01')]
    const merged = mergeTimelinePage(existing, fresh)
    expect(merged.map((item) => item.msgUid)).toEqual(['u1', 'u2'])
  })

  it('按 sentAt 升序、同秒按 pk 升序', () => {
    const merged = mergeTimelinePage([], [msg(2, 'b', '10:01'), msg(1, 'a', '10:01'), msg(3, 'c', '10:00')])
    expect(merged.map((item) => item.pk)).toEqual([3, 1, 2])
  })

  it('无新增时返回原数组（不触发无谓的响应式替换）', () => {
    const existing = [msg(1, 'u1', '10:00')]
    expect(mergeTimelinePage(existing, [msg(1, 'u1', '10:00')])).toBe(existing)
  })
})

describe('aggregate.upsertSortedConvJob', () => {
  it('同 pk 替换不重复', () => {
    const list = upsertSortedConvJob([job(1, { status: 'ready' })], job(1, { status: 'sending' }))
    expect(list).toHaveLength(1)
    expect(list[0].status).toBe('sending')
  })

  it('终态（sent/skipped）不占右栏待办', () => {
    expect(upsertSortedConvJob([], job(1, { status: 'sent' }))).toHaveLength(0)
    expect(upsertSortedConvJob([], job(1, { status: 'skipped' }))).toHaveLength(0)
  })

  it('按 createdAt 升序、同刻按 pk 升序', () => {
    const list = upsertSortedConvJob(
      [job(2, { createdAt: '2026-10-02 10:00:00' })],
      job(1, { createdAt: '2026-10-02 10:00:00' }),
    )
    expect(list.map((item) => item.pk)).toEqual([1, 2])
  })
})

describe('aggregate.applyJobStatusPatch（O7 待审翻转判定）', () => {
  it('ready→ready 带 holdReason：转审是同状态流转，靠事件 holdReason 判定进入待审', () => {
    const target = job(1, { status: 'ready', holdReason: '' })
    const { wasHolding, isHolding } = applyJobStatusPatch(target, 'ready', '', 'blacklist', 'now')
    expect(wasHolding).toBe(false)
    expect(isHolding).toBe(true)
    expect(target.holdReason).toBe('blacklist')
  })

  it('待审 → skipped：退出待审并落拦截原因', () => {
    const target = job(1, { status: 'ready', holdReason: 'blacklist' })
    const { wasHolding, isHolding } = applyJobStatusPatch(target, 'skipped', 'quiet', undefined, 'now')
    expect(wasHolding).toBe(true)
    expect(isHolding).toBe(false)
    expect(target.skipReason).toBe('quiet')
  })

  it('holdReason 未随事件带出时保持原值', () => {
    const target = job(1, { status: 'sending', holdReason: '' })
    applyJobStatusPatch(target, 'sent', '', undefined, 'now')
    expect(target.holdReason).toBe('')
  })
})

describe('aggregate 派生', () => {
  it('sortWatchingDesc：只留监控中、按 lastMsgAt 倒序、同刻 pk 大者在前', () => {
    const sorted = sortWatchingDesc([
      conv(true, '10:00', 1),
      conv(false, '11:00', 2),
      conv(true, '11:00', 3),
      conv(true, '09:00', 4),
    ])
    expect(sorted.map((item) => item.pk)).toEqual([3, 1, 4])
  })

  it('unreadTotalOf 求和', () => {
    expect(unreadTotalOf([conv(true, '', 1), conv(true, '', 3)])).toBe(4)
  })

  it('statusTextOf 全分支', () => {
    expect(statusTextOf('init')).toBe('初始化中')
    expect(statusTextOf('running')).toBe('运行中')
    expect(statusTextOf('backoff')).toBe('退避中')
    expect(statusTextOf('panic')).toBe('急停')
    expect(statusTextOf('stopped')).toBe('已停止')
    expect(statusTextOf('idle')).toBe('未启动')
  })

  it('quotaTextOf：含全局冷却尾缀', () => {
    const base = { globalCount: 3, globalCap: 10 } as SafetySnapshot
    expect(quotaTextOf(base)).toBe('本小时已回 3/10')
    expect(quotaTextOf({ ...base, globalClosedUntil: 'x' } as SafetySnapshot)).toBe('本小时已回 3/10 · 全局冷却中')
  })

  it('sourceBadgeOf：任一 mock 源或非桌面平台都标 mock', () => {
    const settings = {
      welinkSource: 'mock',
      agent: { agentSource: 'http' },
    } as unknown as Parameters<typeof sourceBadgeOf>[0]
    expect(sourceBadgeOf(settings, 'tauri').mock).toBe(true)
    const real = { welinkSource: 'cli', agent: { agentSource: 'http' } } as unknown as Parameters<
      typeof sourceBadgeOf
    >[0]
    expect(sourceBadgeOf(real, 'tauri').mock).toBe(false)
    expect(sourceBadgeOf(real, 'web').mock).toBe(true)
  })
})

describe('aggregate.derivePollPlan（D-6：设置页的数字必须是真的）', () => {
  it('未装载且无实测：known=false，不冒充「0 个会话」，周期照实显示', () => {
    const plan = derivePollPlan({ intervalSec: 5, watchingCount: 0, loaded: false, actualStaggerMs: null })
    expect(plan.known).toBe(false)
    expect(plan.conversationCount).toBe(0)
    expect(plan.periodMs).toBe(5000)
  })

  it('装载后按监控数预估：3 会话 → 2s 错峰 → 周期 9s', () => {
    const plan = derivePollPlan({ intervalSec: 5, watchingCount: 3, loaded: true, actualStaggerMs: null })
    expect(plan.known).toBe(true)
    expect(plan.conversationCount).toBe(3)
    expect(plan.staggerMs).toBe(2000)
    expect(plan.periodMs).toBe(9000)
  })

  it('实测错峰覆盖预估值并标记收敛（20 会话、0.3s 实测 < 预算）', () => {
    const plan = derivePollPlan({ intervalSec: 5, watchingCount: 20, loaded: true, actualStaggerMs: 300 })
    expect(plan.converged).toBe(true)
    expect(plan.staggerMs).toBe(300)
    expect(plan.staggerTotalMs).toBe(19 * 300)
  })

  it('单会话无错峰', () => {
    const plan = derivePollPlan({ intervalSec: 5, watchingCount: 1, loaded: true, actualStaggerMs: null })
    expect(plan.staggerMs).toBe(0)
  })
})

describe('aggregate 展示标签', () => {
  it('已知原因给中文、未知原因原样回显', () => {
    expect(skipLabelOf('quiet')).toBe('静默时段')
    expect(skipLabelOf('mystery')).toBe('mystery')
    expect(holdLabelOf('blacklist')).toBe('命中敏感句式待审')
    expect(holdLabelOf('other')).toBe('other')
    expect(statusLabelOf('ready')).toBe('待发送')
  })
})
