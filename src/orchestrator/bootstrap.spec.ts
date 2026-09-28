import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 启动恢复单测（设计 §12 M3「崩溃恢复三分支」+ §13）。
 *
 * `runtime.spec.ts` 已验证真实接线下的两条 sending 分支；本文件用**最小假件**
 * 把 `bootstrap.run()` 的每个分支穷举干净 —— 尤其是那些真实链路里很难构造的：
 *  * failed 必须**保留原状**（自动重投失败内容 = 滥发风险，这是刻意的设计选择）；
 *  * ready + hold_reason（待审）不得进自动外发队列；
 *  * discussing（上次 worker 出队后进程挂了）要回落 pending 让生成段重新接管；
 *  * 迁移失败必须**早退并告警**，而不是带着坏库继续跑。
 *
 * 这一层的价值在于「边界穷举」：分支多、每条的触发条件都不同，靠集成测试
 * 逐个构造崩溃现场成本太高。
 */
import type { WelinkRepository } from '@/infra/db/ports'
import type { WelinkEvent } from '@/orchestrator/events'
import type { WelinkJob } from '@/types/welink'

const db = vi.hoisted(() => ({
  migrateAll: vi.fn<() => Promise<number[]>>(async () => []),
}))

vi.mock('@/infra/db', () => ({
  dbMigrateAll: db.migrateAll,
  welink: () => {
    throw new Error('测试必须显式注入 repo')
  },
}))

vi.mock('@/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

import { createBootstrap } from '@/orchestrator/bootstrap'

// ---------------------------------------------------------------- 夹具

function job(overrides: Partial<WelinkJob> = {}): WelinkJob {
  return {
    pk: 1,
    triggerMsgPk: 10,
    triggerType: 'group_at_me',
    targetType: 'group',
    targetId: 'G-1001',
    sendModeUsed: 'auto',
    contextSnapshot: '',
    draft: '草稿内容',
    status: 'pending',
    attempts: 0,
    lastError: '',
    skipReason: '',
    holdReason: '',
    rating: null,
    createdAt: '2026-09-27 14:00:00',
    updatedAt: '2026-09-27 14:00:00',
    finishedAt: null,
    triggerSummary: '@我看下',
    targetTitle: '研发一组',
    ...overrides,
  }
}

interface Harness {
  repo: WelinkRepository
  enqueued: number[][]
  events: WelinkEvent[]
  startCalls: { pipeline: number; poller: number }
  statusWrites: Array<{ pk: number; status: string; expect?: string }>
}

function harness(seed: {
  unfinished?: WelinkJob[]
  receipts?: number[]
  watching?: Array<{ convId: string }>
  migrateFails?: boolean
  listFails?: boolean
}): Harness {
  const enqueued: number[][] = []
  const events: WelinkEvent[] = []
  const startCalls = { pipeline: 0, poller: 0 }
  const statusWrites: Array<{ pk: number; status: string; expect?: string }> = []

  if (seed.migrateFails) db.migrateAll.mockRejectedValueOnce(new Error('库文件损坏'))
  else db.migrateAll.mockResolvedValue([2])

  const repo = {
    listUnfinishedJobs: vi.fn(async () => {
      if (seed.listFails) throw new Error('读取失败')
      return seed.unfinished ?? []
    }),
    hasOutgoingReceipt: vi.fn(async (pk: number) => (seed.receipts ?? []).includes(pk)),
    markStatus: vi.fn(async (pk: number, status: string, expect?: string) => {
      statusWrites.push({ pk, status, expect })
      return true
    }),
    suspendJob: vi.fn(async (pk: number) => {
      statusWrites.push({ pk, status: 'ready' })
      return true
    }),
    countGlobalSentSince: vi.fn(async () => 3),
    listWatching: vi.fn(async () => seed.watching ?? []),
    countSentSince: vi.fn(async () => 0),
    lastSentAt: vi.fn(async () => null),
  } as unknown as WelinkRepository

  return {
    repo,
    enqueued,
    events,
    startCalls,
    statusWrites,
  } as Harness & { repo: WelinkRepository }
}

function build(h: Harness, autoStart = true) {
  const pipeline = {
    enqueueMany: (pks: number[]) => h.enqueued.push(pks),
    start: () => {
      h.startCalls.pipeline += 1
    },
  }
  const poller = {
    start: () => {
      h.startCalls.poller += 1
    },
  }
  const gate = {
    primeGlobal: vi.fn(),
    primeConversation: vi.fn(),
  }

  return createBootstrap({
    repo: h.repo,
    poller: poller as never,
    pipeline: pipeline as never,
    gate: gate as never,
    settings: () => ({}) as never,
    emit: (event) => h.events.push(event),
    autoStart,
  })
}

beforeEach(() => {
  db.migrateAll.mockReset()
})

// ---------------------------------------------------------------- 用例

describe('orchestrator/bootstrap —— 崩溃恢复三分支（§6.3）', () => {
  it('sending + 有回执 → 补记 sent，且不重发（防双发）', async () => {
    const h = harness({ unfinished: [job({ pk: 1, status: 'sending' })], receipts: [1] })
    const report = await build(h).run()

    expect(report.recoveredSent).toBe(1)
    expect(report.requeued).toBe(0)
    expect(h.statusWrites).toContainEqual({ pk: 1, status: 'sent', expect: 'sending' })
    // 绝不能进外发队列
    expect(h.enqueued.flat()).not.toContain(1)
    expect(h.events.some((event) => event.type === 'jobStatusChanged' && event.to === 'sent')).toBe(true)
  })

  it('sending + 无回执 → 回落 ready 并重新入队（draft 未变，幂等重发）', async () => {
    const h = harness({ unfinished: [job({ pk: 2, status: 'sending' })], receipts: [] })
    const report = await build(h).run()

    expect(report.requeued).toBe(1)
    expect(report.recoveredSent).toBe(0)
    expect(h.statusWrites).toContainEqual({ pk: 2, status: 'ready' })
    expect(h.enqueued.flat()).toContain(2)
  })

  it('pending / ready（无 hold）→ 重新入队', async () => {
    const h = harness({
      unfinished: [job({ pk: 3, status: 'pending' }), job({ pk: 4, status: 'ready' })],
    })
    const report = await build(h).run()
    expect(report.enqueued).toBe(2)
    expect(h.enqueued.flat()).toEqual([3, 4])
  })

  it('discussing → 回落 pending 后入队（上次 worker 出队后进程挂了）', async () => {
    const h = harness({ unfinished: [job({ pk: 5, status: 'discussing' })] })
    const report = await build(h).run()

    expect(report.enqueued).toBe(1)
    expect(h.statusWrites).toContainEqual({ pk: 5, status: 'pending', expect: 'discussing' })
    expect(h.enqueued.flat()).toContain(5)
  })

  it('failed → **保留原状**，只统计并告知 UI（自动重投失败内容 = 滥发风险）', async () => {
    const h = harness({ unfinished: [job({ pk: 6, status: 'failed', attempts: 3 })] })
    const report = await build(h).run()

    expect(report.failed).toBe(1)
    expect(report.enqueued).toBe(0)
    expect(h.enqueued.flat()).not.toContain(6)
    expect(h.statusWrites).toHaveLength(0)
  })

  it('ready + hold_reason（待审）→ 不进自动外发队列', async () => {
    const h = harness({
      unfinished: [job({ pk: 7, status: 'ready', holdReason: 'manual_mode' })],
    })
    const report = await build(h).run()

    expect(report.enqueued).toBe(0)
    expect(h.enqueued.flat()).not.toContain(7)
  })

  it('混合场景：四类任务各归各位（一次恢复全部分流）', async () => {
    const h = harness({
      unfinished: [
        job({ pk: 10, status: 'sending' }),
        job({ pk: 11, status: 'sending' }),
        job({ pk: 12, status: 'discussing' }),
        job({ pk: 13, status: 'ready', holdReason: 'blacklist' }),
        job({ pk: 14, status: 'failed' }),
      ],
      receipts: [10],
    })
    const report = await build(h).run()

    expect(report.recoveredSent).toBe(1)
    expect(report.requeued).toBe(1)
    expect(report.enqueued).toBe(1)
    expect(report.failed).toBe(1)
    expect(h.enqueued.flat()).toEqual([11, 12])
  })
})

describe('orchestrator/bootstrap —— 迁移、预热与调度', () => {
  it('迁移失败 → 早退并告警（不带坏库往下跑）', async () => {
    const h = harness({ migrateFails: true, unfinished: [job({ pk: 1 })] })
    const report = await build(h).run()

    expect(report.warnings[0]).toContain('数据库迁移失败')
    // 早退：没读任务、没入队、没启动
    expect(report.enqueued).toBe(0)
    expect(h.startCalls.pipeline).toBe(0)
    expect(h.startCalls.poller).toBe(0)
  })

  it('读取未完成任务失败 → 告警但不中断（其余步骤照常）', async () => {
    const h = harness({ listFails: true, watching: [{ convId: 'G-1' }] })
    const report = await build(h).run()

    expect(report.warnings.some((item) => item.includes('读取未完成任务失败'))).toBe(true)
    expect(report.watching).toBe(1)
    expect(h.startCalls.pipeline).toBe(1)
  })

  it('迁移只跑一次（幂等；重复调用不重复应用）', async () => {
    db.migrateAll.mockResolvedValue([])
    const h = harness({})
    const bootstrap = build(h)
    await bootstrap.run()
    await bootstrap.run()
    expect(db.migrateAll).toHaveBeenCalledTimes(2) // 调用两次，但宿主侧 _migrations 保证幂等
  })

  it('autoStart=true 才启动调度；false 时只恢复数据', async () => {
    const on = harness({})
    await build(on, true).run()
    expect(on.startCalls).toEqual({ pipeline: 1, poller: 1 })

    const off = harness({})
    await build(off, false).run()
    expect(off.startCalls).toEqual({ pipeline: 0, poller: 0 })
  })

  it('lastReport 返回最近一次报告（UI 启动 toast 用）', async () => {
    const h = harness({ unfinished: [job({ pk: 1, status: 'ready' })] })
    const bootstrap = build(h)
    expect(bootstrap.lastReport()).toBeNull()
    const report = await bootstrap.run()
    expect(bootstrap.lastReport()).toBe(report)
  })
})
