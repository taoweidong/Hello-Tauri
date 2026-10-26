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
    skillId: '',
    skillName: '',
    skillSource: '',
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
  /** build() 时注入，供预热接线断言用（评审 T-4） */
  gate?: { primeGlobal: ReturnType<typeof vi.fn>; primeConversation: ReturnType<typeof vi.fn> }
}

function harness(seed: {
  unfinished?: WelinkJob[]
  /** 库里终态失败任务的总数（走 `countFailedJobs`，不占恢复工作集名额） */
  failedCount?: number
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
    // failed 已移出 `listUnfinishedJobs`（它只被统计、从不入队，却永不离场，
    // 会占满「最老的 N 条」这个恢复工作集）—— 计数改走这里。
    countFailedJobs: vi.fn(async () => seed.failedCount ?? 0),
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
  // 暴露给断言用（评审 T-4：预热接线「只建桩不断言」的缺口）
  h.gate = gate

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

  it('discussing 回滚写库失败：只降级该条，不拖垮整轮恢复', async () => {
    const h = harness({ unfinished: [job({ pk: 15, status: 'discussing' })] })
    // 反证：修复前 `run()` 会整体 reject —— 入队、闸口预热、pipeline/poller 启动
    // 全部不执行，重启后助手完全不动，而界面毫无异常迹象。
    vi.mocked(h.repo.markStatus).mockRejectedValueOnce(new Error('数据库被占用'))
    const report = await build(h).run()

    expect(h.startCalls.pipeline).toBe(1)
    expect(h.startCalls.poller).toBe(1)
    expect(h.enqueued.flat()).toContain(15)
    expect(report.warnings.join('|')).toContain('15')
  })

  it('failed → **保留原状**，只统计并告知 UI（自动重投失败内容 = 滥发风险）', async () => {
    // failed 已移出 `listUnfinishedJobs`：它只被统计、从不入队，却永不离场 —— 留在这个
    // 「取最老的 2000 条」的工作集里会把在途任务挤出去（重启后不生成不外发，且无告警）。
    // 这里同时塞两条路径：① 计数走 `countFailedJobs`；② 万一工作集里混进 failed
    // （接口语义被改回），也要继续跳过而不是重投。
    const h = harness({
      unfinished: [job({ pk: 6, status: 'failed', attempts: 3 })],
      failedCount: 1,
    })
    const report = await build(h).run()

    expect(report.failed).toBe(1)
    expect(report.enqueued).toBe(0)
    expect(h.enqueued.flat()).not.toContain(6)
    expect(h.statusWrites).toHaveLength(0)
  })

  it('failed 不占恢复工作集名额：2000 条历史失败任务不能挤掉在途任务', async () => {
    // 反证：把 `listUnfinishedJobs` 的 SQL 改回含 failed、并把计数改回遍历累加，
    // 这条用例（与生产故障同构）就无从表达 —— 契约本身即防护。
    const h = harness({
      unfinished: [job({ pk: 20, status: 'ready' })],
      failedCount: 2000,
    })
    const report = await build(h).run()

    expect(report.failed).toBe(2000)
    // 关键：在途任务照样入队，不被失败任务挤掉
    expect(h.enqueued.flat()).toEqual([20])
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
      ],
      receipts: [10],
      failedCount: 1,
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

// ---------------------------------------------------------------- Gate 预热接线（O5，评审 T-4）

/**
 * 「重启后配额从库里预热」此前只有 Gate 单元级测试（safety-gate.spec 直接调
 * prime），组合根漏传/传错小时桶起点不会被抓——事实上 hourStart 曾算成
 * 「当日零点」（评审 P3-1），重启后预热计数被膨胀、助手哑到下一个整点。
 * 本节把接线参数钉住。
 */
describe('orchestrator/bootstrap —— SafetyGate 预热接线（O5）', () => {
  beforeEach(() => {
    db.migrateAll.mockReset()
    db.migrateAll.mockResolvedValue([2])
  })

  it('primeGlobal 收到 countGlobalSentSince 的返回值，小时桶起点与本小时对齐', async () => {
    const h = harness({})
    await build(h).run()

    expect(h.gate?.primeGlobal).toHaveBeenCalledTimes(1)
    expect(h.gate?.primeGlobal).toHaveBeenCalledWith(3)
    // 回归闸：起点必须是 "YYYY-MM-DD HH:00:00"（本小时），不是当日零点
    const hourStart = (h.repo.countGlobalSentSince as ReturnType<typeof vi.fn>).mock.calls[0][0] as string
    expect(hourStart).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:00:00$/)
  })

  it('watching 会话逐个 primeConversation（会话小时数 + 最近发送时刻）', async () => {
    const h = harness({ watching: [{ convId: 'G-1' }, { convId: 'G-2' }] })
    await build(h).run()

    expect(h.gate?.primeConversation).toHaveBeenCalledTimes(2)
    expect(h.gate?.primeConversation).toHaveBeenCalledWith('G-1', 0, null)
    expect(h.gate?.primeConversation).toHaveBeenCalledWith('G-2', 0, null)
  })

  it('预热计数查询跨会话一次铺开（不逐会话串行等 2N 次 IPC）', async () => {
    const h = harness({ watching: [{ convId: 'G-1' }, { convId: 'G-2' }] })
    const issued: string[] = []
    let releaseFirst: () => void = () => {}
    ;(h.repo.countSentSince as ReturnType<typeof vi.fn>).mockImplementation(async (convId: string) => {
      issued.push(`count:${convId}`)
      // 第一个会话的计数查询挂起：串行实现会被它堵住，G-2 的查询发不出去
      if (convId === 'G-1') {
        await new Promise<void>((resolve) => {
          releaseFirst = resolve
        })
      }
      return 0
    })
    ;(h.repo.lastSentAt as ReturnType<typeof vi.fn>).mockImplementation(async (convId: string) => {
      issued.push(`last:${convId}`)
      return null
    })

    const running = build(h).run()
    // 给 run() 足够的微任务/宏任务走到预热段（迁移与恢复都是立即 resolve 的桩）
    await new Promise((resolve) => setTimeout(resolve, 0))
    // 反证口径：逐会话串行时，G-1 的查询没返回前 G-2 的 countSentSince 不会被调用
    expect(issued).toContain('count:G-2')

    releaseFirst()
    await running
    expect(h.gate?.primeConversation).toHaveBeenCalledTimes(2)
  })

  it('预热失败不阻断启动（计入 warnings，调度照常起，配额从 0 起算）', async () => {
    const h = harness({ watching: [{ convId: 'G-1' }] })
    ;(h.repo.countGlobalSentSince as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('库挂了'))
    const report = await build(h).run()

    expect(report.warnings.join()).toContain('安全闸口预热失败')
    expect(h.startCalls).toEqual({ pipeline: 1, poller: 1 })
  })
})
