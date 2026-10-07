import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 保留期清理单测（质量报告 D-1 + S-4 的回归闸）。
 *
 * 这个文件存在的意义就是「证明调度真的接上了」：`purgeMessagesBefore` 与
 * `purgeAgentLogsBefore` 早就有实现、早就通过 SQL 断言，但**全仓库无人调用** ——
 * 于是保留期形同虚设。所以这里断言的重点不是「删得对不对」（那是仓储层的职责），
 * 而是：
 *  * 定时链是否排上、是否**每日一次**、是否用 setTimeout 链而非 setInterval；
 *  * 是否**分批循环到 0**，而不是删一批就收工（删一批 = 永远追不上增长）；
 *  * 单轮失败是否**不中断链条**（否则库抖一次就永久停摆）；
 *  * single-flight：手动与自动不并发删同一批行。
 *
 * 时间与仓储都替换成可控假件，测试不依赖真实计时器与真实数据库。
 */
const logger = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }))
vi.mock('@/utils/logger', () => ({ logger }))

vi.mock('@/infra/db', () => ({
  welink: () => {
    throw new Error('测试必须显式注入 repo')
  },
}))

import { createRetention, PURGE_MAX_ROUNDS, type RetentionReport } from '@/orchestrator/retention'
import { AGENT_LOG_KEEP_DAYS, PURGE_BATCH_SIZE, RETENTION_KEEP_DAYS } from '@/infra/db/ports'
import type { WelinkRepository } from '@/infra/db/ports'
import type { TimerApi } from '@/orchestrator/timers'

// ---------------------------------------------------------------- 假时钟

interface Scheduler {
  timers: TimerApi
  queued: number
  advance(ms: number): Promise<void>
}

function createScheduler(): Scheduler {
  let current = 0
  let seq = 0
  const pending = new Map<number, { at: number; handler: () => void }>()
  const timers: TimerApi = {
    set(handler, delayMs) {
      const id = ++seq
      pending.set(id, { at: current + Math.max(0, delayMs), handler })
      return id
    },
    clear(id) {
      if (typeof id === 'number') pending.delete(id)
    },
  }
  return {
    timers,
    get queued() {
      return pending.size
    },
    async advance(ms) {
      current += ms
      for (const [id, item] of [...pending.entries()]) {
        if (item.at <= current) {
          pending.delete(id)
          item.handler()
        }
      }
      // 让链上的 await 跑干净（setTimeout 链里 handler 返回 void，内部是 Promise）
      for (let index = 0; index < 40; index += 1) await Promise.resolve()
    },
  }
}

// ---------------------------------------------------------------- 假仓储

interface RepoHarness {
  repo: WelinkRepository
  /** 每次 purge 调用的 [cutoff, batch]，用来断言「截止时刻按保留天数算」 */
  messageCalls: Array<[string, number]>
  logCalls: Array<[string, number]>
  /** 预置每批返回的行数序列（用完后返回 0 = 已清空） */
  messageBatches: number[]
  logBatches: number[]
  failNextMessages(times: number, message: string): void
}

function createRepo(): RepoHarness {
  const messageCalls: Array<[string, number]> = []
  const logCalls: Array<[string, number]> = []
  let messageBatches: number[] = []
  let logBatches: number[] = []
  let failures = 0
  let failureMessage = ''

  const repo = {
    async purgeMessagesBefore(cutoff: string, batch: number) {
      messageCalls.push([cutoff, batch])
      if (failures > 0) {
        failures -= 1
        throw new Error(failureMessage)
      }
      return messageBatches.shift() ?? 0
    },
    async purgeAgentLogsBefore(cutoff: string, batch: number) {
      logCalls.push([cutoff, batch])
      return logBatches.shift() ?? 0
    },
  } as unknown as WelinkRepository

  return {
    repo,
    messageCalls,
    logCalls,
    get messageBatches() {
      return messageBatches
    },
    set messageBatches(value: number[]) {
      messageBatches = value
    },
    get logBatches() {
      return logBatches
    },
    set logBatches(value: number[]) {
      logBatches = value
    },
    failNextMessages(times, message) {
      failures = times
      failureMessage = message
    },
  }
}

/** 固定「现在」= 2026-09-28 10:00:00，便于断言截止时刻的字面值 */
const FIXED_NOW = new Date(2026, 8, 28, 10, 0, 0)

let scheduler: Scheduler
let harness: RepoHarness

beforeEach(() => {
  scheduler = createScheduler()
  harness = createRepo()
  logger.info.mockClear()
  logger.warn.mockClear()
  logger.error.mockClear()
})

function build(overrides: Partial<Parameters<typeof createRetention>[0]> = {}) {
  return createRetention({
    repo: harness.repo,
    timers: scheduler.timers,
    now: () => FIXED_NOW,
    firstDelayMs: 100,
    intervalMs: 1000,
    ...overrides,
  })
}

// ---------------------------------------------------------------- 用例

describe('orchestrator/retention —— 保留期清理的调度与收敛', () => {
  it('保留期按仓储层常量换算成截止时刻（消息 180 天 / 语料 90 天）', async () => {
    harness.messageBatches = [0]
    harness.logBatches = [0]
    const retention = build()

    await retention.runOnce()

    // 2026-09-28 10:00:00 减 180 天 = 2026-04-01 10:00:00；减 90 天 = 2026-06-30 10:00:00
    expect(harness.messageCalls[0][0]).toBe('2026-04-01 10:00:00')
    expect(harness.logCalls[0][0]).toBe('2026-06-30 10:00:00')
    // 批量必须是仓储层常量，不能各写各的
    expect(harness.messageCalls[0][1]).toBe(PURGE_BATCH_SIZE)
    expect(harness.logCalls[0][1]).toBe(PURGE_BATCH_SIZE)
    expect(RETENTION_KEEP_DAYS).toBe(180)
    expect(AGENT_LOG_KEEP_DAYS).toBe(90)
  })

  it('删满一批就继续删，直到某一批少于批量为止（删一批就收工 = 永远追不上增长）', async () => {
    // 两批各 500（满批 → 继续），第三批 13（不满 → 收敛）
    harness.messageBatches = [PURGE_BATCH_SIZE, PURGE_BATCH_SIZE, 13]
    harness.logBatches = [PURGE_BATCH_SIZE, 0]
    const retention = build()

    const report = await retention.runOnce()

    expect(report.messages).toBe(PURGE_BATCH_SIZE * 2 + 13)
    expect(report.agentLogs).toBe(PURGE_BATCH_SIZE)
    expect(report.capped).toBe(false)
    expect(harness.messageCalls).toHaveLength(3)
    expect(harness.logCalls).toHaveLength(2)
  })

  it('病态数据量下触到轮次上限即收手（不让清理长时间占着数据库）', async () => {
    // 每批都满 → 会一直删，必须被 PURGE_MAX_ROUNDS 截断
    harness.messageBatches = Array.from({ length: PURGE_MAX_ROUNDS + 10 }, () => PURGE_BATCH_SIZE)
    harness.logBatches = [0]
    const retention = build()

    const report = await retention.runOnce()

    expect(report.capped).toBe(true)
    expect(harness.messageCalls).toHaveLength(PURGE_MAX_ROUNDS)
    expect(report.messages).toBe(PURGE_BATCH_SIZE * PURGE_MAX_ROUNDS)
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('触上限'))
  })

  it('start 只排一次定时器（幂等），且首轮延迟后才真正开动', async () => {
    harness.messageBatches = [0]
    harness.logBatches = [0]
    const retention = build()

    retention.start()
    retention.start()
    retention.start()
    expect(scheduler.queued).toBe(1)

    // 未到首轮延迟：一次都不该删
    await scheduler.advance(50)
    expect(harness.messageCalls).toHaveLength(0)

    await scheduler.advance(50)
    expect(harness.messageCalls.length).toBeGreaterThan(0)
  })

  it('定时链用 setTimeout 单次排程（上一轮结束后才排下一轮），stop 后清干净', async () => {
    harness.messageBatches = [0, 0, 0, 0, 0, 0]
    harness.logBatches = [0, 0, 0, 0, 0, 0]
    const retention = build()

    retention.start()
    await scheduler.advance(100)
    // 一轮跑完后正好排着下一轮（且只有 1 个 —— setInterval 会留两个以上）
    expect(scheduler.queued).toBe(1)
    expect(retention.running()).toBe(true)

    await scheduler.advance(1000)
    expect(harness.messageCalls).toHaveLength(2)

    retention.stop()
    expect(scheduler.queued).toBe(0)
    expect(retention.running()).toBe(false)

    // 停掉之后再推时间也不会再删
    await scheduler.advance(5000)
    expect(harness.messageCalls).toHaveLength(2)
  })

  it('stop 是暂停不是终态：再次 start 能重新排程（关一次总开关就永久停摆是回归）', async () => {
    harness.messageBatches = [0, 0, 0, 0]
    harness.logBatches = [0, 0, 0, 0]
    const retention = build()

    retention.start()
    await scheduler.advance(100)
    expect(retention.running()).toBe(true)

    // 模拟用户关总开关：runtime.stop() → retention.stop()
    retention.stop()
    expect(retention.running()).toBe(false)
    expect(scheduler.queued).toBe(0)

    // 再打开总开关：runtime.start() → retention.start() —— 必须能重新排程。
    // 早期实现里 stop() 置 disposed=true 且无复位入口，此处会永久 no-op，
    // 清理能力静默消失（本模块存在的唯一理由就是防这个）。
    retention.start()
    expect(scheduler.queued).toBe(1)
    await scheduler.advance(100)
    expect(harness.messageCalls.length).toBeGreaterThanOrEqual(2)
  })

  it('dispose 是终态：dispose 后 start 不再生效（与 stop 的语义区别）', () => {
    harness.messageBatches = [0]
    harness.logBatches = [0]
    const retention = build()

    retention.start()
    retention.dispose()
    expect(retention.running()).toBe(false)
    expect(scheduler.queued).toBe(0)

    retention.start()
    expect(scheduler.queued).toBe(0)
  })

  it('单轮失败不中断链条：告警后照常排下一轮（库抖一次不能永久停摆）', async () => {
    harness.failNextMessages(1, '库挂了')
    harness.messageBatches = []
    harness.logBatches = [0, 0, 0]
    const retention = build()

    retention.start()
    await scheduler.advance(100)
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('库挂了'))
    // 失败后仍排着下一轮
    expect(scheduler.queued).toBe(1)

    await scheduler.advance(1000)
    expect(harness.messageCalls.length).toBeGreaterThanOrEqual(2)
  })

  it('single-flight：手动触发与自动轮次共用同一次执行（不重复删同一批行）', async () => {
    harness.messageBatches = [0]
    harness.logBatches = [0]
    const retention = build()

    const [a, b, c] = await Promise.all([retention.runOnce(), retention.runOnce(), retention.runOnce()])

    expect(harness.messageCalls).toHaveLength(1)
    expect(harness.logCalls).toHaveLength(1)
    expect(a).toEqual(b)
    expect(b).toEqual(c)
  })

  it('清理日志只在真删到东西时打印（全 0 不刷屏）', async () => {
    harness.messageBatches = [0]
    harness.logBatches = [0]
    const retention = build()
    await retention.runOnce()
    expect(logger.info).not.toHaveBeenCalled()

    harness.messageBatches = [7]
    harness.logBatches = [3]
    await retention.runOnce()
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('消息 -7 条 / 语料 -3 条'))
  })

  it('lastReport 暴露上次结果（监控页展示「上次清理删了多少」）', async () => {
    harness.messageBatches = [5]
    harness.logBatches = [2]
    const retention = build()

    expect(retention.lastReport()).toBeNull()
    const report = await retention.runOnce()
    expect(report satisfies RetentionReport).toBe(retention.lastReport())
    expect(retention.lastReport()).toEqual({ messages: 5, agentLogs: 2, capped: false })
  })

  it('keepDays 可覆盖（测试/定制保留期），截止时刻随之变化', async () => {
    harness.messageBatches = [0]
    harness.logBatches = [0]
    const retention = build({ keepDays: { messages: 1, agentLogs: 2 } })

    await retention.runOnce()

    expect(harness.messageCalls[0][0]).toBe('2026-09-27 10:00:00')
    expect(harness.logCalls[0][0]).toBe('2026-09-26 10:00:00')
  })
})
