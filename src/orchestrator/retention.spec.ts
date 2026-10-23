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
vi.mock('@/utils/logger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/utils/logger')>()
  return { ...actual, logger }
})

vi.mock('@/infra/db', () => ({
  welink: () => {
    throw new Error('测试必须显式注入 repo')
  },
  sediment: () => {
    throw new Error('测试必须显式注入 sedimentRepo')
  },
}))

import { createRetention, PURGE_MAX_ROUNDS, type RetentionReport } from '@/orchestrator/retention'
import {
  AGENT_LOG_KEEP_DAYS,
  ANNOUNCEMENT_KEEP_DAYS,
  JOB_KEEP_DAYS,
  PURGE_BATCH_SIZE,
  RETENTION_KEEP_DAYS,
  SEDIMENT_LOG_KEEP_DAYS,
} from '@/infra/db/ports'
import type { WelinkRepository } from '@/infra/db/ports'
import type { SedimentRepository } from '@/infra/db/sediment-ports'
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
  /** job 清理的调用记录与预置批序（第七轮新增的第五条链） */
  jobCalls: Array<[string, number]>
  jobBatches: number[]
  /**
   * **所有**清理链的调用时序（共享一根序列）。
   *
   * ❗顺序断言只能用这一根序列，不能用「各自调用记录的拼接」——
   * `[...jobCalls, ...messageCalls][0] === jobCalls[0]` 是**恒真**的，
   * 改了实现也不会变红（本轮第一版就写成了这个，反证时抓出来的）。
   */
  callOrder: string[]
  /** 每次 purge 调用的 [cutoff, batch]，用来断言「截止时刻按保留天数算」 */
  messageCalls: Array<[string, number]>
  logCalls: Array<[string, number]>
  sedimentCalls: Array<[string, number]>
  announcementCalls: Array<[string, number]>
  /** 预置每批返回的行数序列（用完后返回 0 = 已清空） */
  messageBatches: number[]
  logBatches: number[]
  sedimentBatches: number[]
  announcementBatches: number[]
  /** 沉淀仓储替身（v11：留痕进清理链；v12：公告同轮清理） */
  sedimentRepo: SedimentRepository
  failNextMessages(times: number, message: string): void
}

function createRepo(): RepoHarness {
  const jobCalls: Array<[string, number]> = []
  const callOrder: string[] = []
  const messageCalls: Array<[string, number]> = []
  const logCalls: Array<[string, number]> = []
  const sedimentCalls: Array<[string, number]> = []
  const announcementCalls: Array<[string, number]> = []
  let jobBatches: number[] = []
  let messageBatches: number[] = []
  let logBatches: number[] = []
  let sedimentBatches: number[] = []
  let announcementBatches: number[] = []
  let failures = 0
  let failureMessage = ''

  const repo = {
    async purgeMessagesBefore(cutoff: string, batch: number) {
      messageCalls.push([cutoff, batch])
      callOrder.push('messages')
      if (failures > 0) {
        failures -= 1
        throw new Error(failureMessage)
      }
      return messageBatches.shift() ?? 0
    },
    async purgeAgentLogsBefore(cutoff: string, batch: number) {
      logCalls.push([cutoff, batch])
      callOrder.push('agentLogs')
      return logBatches.shift() ?? 0
    },
    // 第七轮：回复任务进清理链（保留期见 `ports.JOB_KEEP_DAYS`）。
    // 注意它在链里**排在消息之前**（先清 job 才能解放被引用的过期消息）。
    async purgeJobsBefore(cutoff: string, batch: number) {
      jobCalls.push([cutoff, batch])
      callOrder.push('jobs')
      return jobBatches.shift() ?? 0
    },
  } as unknown as WelinkRepository

  const sedimentRepo = {
    async purgeSedimentLogsBefore(cutoff: string, batch: number) {
      sedimentCalls.push([cutoff, batch])
      callOrder.push('sedimentLogs')
      return sedimentBatches.shift() ?? 0
    },
    async purgeAnnouncementsBefore(cutoff: string, batch: number) {
      announcementCalls.push([cutoff, batch])
      callOrder.push('announcements')
      return announcementBatches.shift() ?? 0
    },
  } as unknown as SedimentRepository

  return {
    repo,
    sedimentRepo,
    jobCalls,
    callOrder,
    messageCalls,
    logCalls,
    sedimentCalls,
    announcementCalls,
    get jobBatches() {
      return jobBatches
    },
    set jobBatches(value: number[]) {
      jobBatches = value
    },
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
    get sedimentBatches() {
      return sedimentBatches
    },
    set sedimentBatches(value: number[]) {
      sedimentBatches = value
    },
    get announcementBatches() {
      return announcementBatches
    },
    set announcementBatches(value: number[]) {
      announcementBatches = value
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
    sedimentRepo: harness.sedimentRepo,
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

  it('回复任务按 JOB_KEEP_DAYS 清理，且**排在消息之前**（先清 job 才能解放被引用消息）', async () => {
    harness.messageBatches = [0]
    harness.logBatches = [0]
    const retention = build()

    const report = await retention.runOnce()

    // 2026-09-28 10:00:00 减 180 天 = 2026-04-01 10:00:00
    expect(harness.jobCalls[0][0]).toBe('2026-04-01 10:00:00')
    expect(harness.jobCalls[0][1]).toBe(PURGE_BATCH_SIZE)
    expect(JOB_KEEP_DAYS).toBe(180)
    expect(report.jobs).toBe(0)

    // 顺序断言：job 链的调用必须早于消息链。
    // 反证：把 doRun 里 jobs 那一路挪到 messages 之后，这条会红。
    // 为什么必须是这个顺序：`purgeMessagesBefore` 的 `NOT EXISTS` 会跳过仍被 job 引用的
    // 消息 —— job 不清，那批消息就永远清不掉（多等一整天也不行）。
    expect(harness.jobCalls).toHaveLength(1)
    expect(harness.messageCalls).toHaveLength(1)
    expect(harness.callOrder.indexOf('jobs')).toBeLessThan(harness.callOrder.indexOf('messages'))
  })

  it('清理链串行推进：同一时刻只有一路在删（不叠加成并发删除）', async () => {
    // 反证：把 doRun 改回 `Promise.all`，这条立刻红。
    // 文件头约束 1 写的就是「避免慢库上叠加成并发删除」—— 四条链并发会同时抢宿主的
    // SQLite 全局连接锁。清理是后台动作，慢一点无所谓，把前台查询拖住才是问题。
    harness.messageBatches = [0]
    harness.logBatches = [0]
    let inFlight = 0
    let maxConcurrent = 0
    const probe = async (): Promise<number> => {
      inFlight += 1
      maxConcurrent = Math.max(maxConcurrent, inFlight)
      await Promise.resolve()
      inFlight -= 1
      return 0
    }
    harness.repo.purgeJobsBefore = probe
    harness.repo.purgeMessagesBefore = probe
    const retention = build()

    await retention.runOnce()

    expect(maxConcurrent).toBe(1)
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

  it('stop 后不再续排：即便清理正在飞，其 finally 也不得把链条接回来（静默复活回归）', async () => {
    // 反证过的回归闸：修复前只要「stop 发生在某一轮清理的进行中」，
    // 该轮末尾的 .finally(() => schedule(intervalMs)) 会无条件排下一轮，
    // 于是「已停止」只是表象——running() 为假、timer 已清，下一轮却照删不误。
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let purgeCalls = 0
    const slowRepo = {
      // 挂在消息链上（job 链排在它之前且瞬时返回，不影响本用例的时序）
      async purgeJobsBefore() {
        return 0
      },
      async purgeMessagesBefore() {
        purgeCalls += 1
        await gate
        return 0
      },
      async purgeAgentLogsBefore() {
        return 0
      },
    } as unknown as WelinkRepository

    const retention = createRetention({
      repo: slowRepo,
      sedimentRepo: harness.sedimentRepo,
      timers: scheduler.timers,
      now: () => FIXED_NOW,
      firstDelayMs: 100,
      intervalMs: 1000,
    })

    retention.start()
    await scheduler.advance(150)
    expect(purgeCalls).toBe(1) // 已进入在飞轮次（此时 timer 为 null，只靠 timer 判不出在跑）

    retention.stop()
    expect(scheduler.queued).toBe(0)

    release()
    await scheduler.advance(0) // 让在飞轮次的 finally 跑完

    // 关键断言：在飞轮次收尾后不得复活出新的定时器
    expect(scheduler.queued).toBe(0)
    expect(retention.running()).toBe(false)

    // 再推足够长的时间，也不该有任何新的删除
    await scheduler.advance(10000)
    expect(purgeCalls).toBe(1)
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
    expect(retention.lastReport()).toEqual({
      jobs: 0,
      messages: 5,
      agentLogs: 2,
      sedimentLogs: 0,
      announcements: 0,
      capped: false,
    })
  })

  it('keepDays 可覆盖（测试/定制保留期），截止时刻随之变化', async () => {
    harness.messageBatches = [0]
    harness.logBatches = [0]
    const retention = build({ keepDays: { messages: 1, agentLogs: 2 } })

    await retention.runOnce()

    expect(harness.messageCalls[0][0]).toBe('2026-09-27 10:00:00')
    expect(harness.logCalls[0][0]).toBe('2026-09-26 10:00:00')
  })

  // —— 第五轮：沉淀留痕此前「接口写好了但无人调用」，是三张表里唯一没进清理链的 ——
  describe('沉淀提取留痕（v11）', () => {
    it('留痕与消息/语料同轮清理，保留期独立（默认 30 天）', async () => {
      harness.messageBatches = [0]
      harness.logBatches = [0]
      harness.sedimentBatches = [0]
      const retention = build()

      await retention.runOnce()

      // 2026-09-28 10:00:00 减 30 天 = 2026-08-29 10:00:00
      expect(harness.sedimentCalls[0][0]).toBe('2026-08-29 10:00:00')
      expect(harness.sedimentCalls[0][1]).toBe(PURGE_BATCH_SIZE)
      expect(SEDIMENT_LOG_KEEP_DAYS).toBe(30)
      // 与消息(180)/语料(90)三档互相独立，互不影响
      expect(harness.messageCalls[0][0]).toBe('2026-04-01 10:00:00')
      expect(harness.logCalls[0][0]).toBe('2026-06-30 10:00:00')
    })

    it('留痕删到收敛，计数进报告与日志（留痕单条可达 10KB，是三表里单位体积最大的）', async () => {
      harness.messageBatches = [0]
      harness.logBatches = [0]
      harness.sedimentBatches = [PURGE_BATCH_SIZE, 9]
      const retention = build()

      const report = await retention.runOnce()

      expect(report.sedimentLogs).toBe(PURGE_BATCH_SIZE + 9)
      expect(harness.sedimentCalls).toHaveLength(2)
      expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('沉淀留痕 -509 条'))
    })

    it('留痕清理抛错不拖垮整轮（四路并行，但失败会冒泡成单轮失败并照常续排）', async () => {
      harness.messageBatches = [3]
      harness.logBatches = [0]
      // 没有预置 sedimentBatches 时假件返回 0；这里改成抛错验证「不中断链条」
      harness.sedimentRepo = {
        async purgeSedimentLogsBefore() {
          throw new Error('留痕库抖了')
        },
        async purgeAnnouncementsBefore() {
          return 0
        },
      } as unknown as SedimentRepository
      const failing = createRetention({
        repo: harness.repo,
        sedimentRepo: harness.sedimentRepo,
        timers: scheduler.timers,
        now: () => FIXED_NOW,
        firstDelayMs: 100,
        intervalMs: 1000,
      })

      failing.start()
      await scheduler.advance(100)
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('留痕库抖了'))
      // 失败后仍排着下一轮（与消息清理同一条「不能永久停摆」的纪律）
      expect(scheduler.queued).toBe(1)
    })
  })

  // —— 第六轮：群公告是沉淀域里唯一一张「既无保留期、又持续写入」的表 ——
  describe('群公告（v12）', () => {
    it('公告与消息/语料/留痕同轮清理，保留期独立（默认 90 天）', async () => {
      harness.messageBatches = [0]
      harness.logBatches = [0]
      harness.sedimentBatches = [0]
      harness.announcementBatches = [0]
      const retention = build()

      await retention.runOnce()

      // 2026-09-28 10:00:00 减 90 天 = 2026-06-30 10:00:00
      expect(harness.announcementCalls[0][0]).toBe('2026-06-30 10:00:00')
      expect(harness.announcementCalls[0][1]).toBe(PURGE_BATCH_SIZE)
      expect(ANNOUNCEMENT_KEEP_DAYS).toBe(90)
    })

    it('公告删到收敛，计数进报告与日志', async () => {
      harness.messageBatches = [0]
      harness.logBatches = [0]
      harness.announcementBatches = [PURGE_BATCH_SIZE, 4]
      const retention = build()

      const report = await retention.runOnce()

      expect(report.announcements).toBe(PURGE_BATCH_SIZE + 4)
      expect(harness.announcementCalls).toHaveLength(2)
      expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('公告 -504 条'))
    })

    it('公告保留期可被 keepDays 单独覆盖（与其它三档互不影响）', async () => {
      harness.messageBatches = [0]
      harness.logBatches = [0]
      harness.announcementBatches = [0]
      const retention = build({ keepDays: { messages: 180, agentLogs: 90, announcements: 7 } })

      await retention.runOnce()

      // 2026-09-28 减 7 天 = 2026-09-21 10:00:00
      expect(harness.announcementCalls[0][0]).toBe('2026-09-21 10:00:00')
      // 消息/语料仍走各自的档位，没有被公告的覆盖带偏
      expect(harness.messageCalls[0][0]).toBe('2026-04-01 10:00:00')
      expect(harness.logCalls[0][0]).toBe('2026-06-30 10:00:00')
    })
  })
})
