/**
 * 保留期清理（设计 §8 / §10；质量报告 D-1 + S-4）。
 *
 * 为什么必须有这一层：`RETENTION_KEEP_DAYS` / `PURGE_BATCH_SIZE` /
 * `purgeMessagesBefore` / `purgeAgentLogsBefore` 都是**早就写好但无人调用**的能力 ——
 * 于是 `welink_messages` 与 `welink_agent_logs` 无界增长。桌面应用是长跑场景
 * （每分钟一轮轮询、每轮可能入库几十条），千级数据时察觉不到，上线三个月后
 * 所有列表查询一起变慢。清理任务缺的不是实现，是**调度**。
 *
 * 三条设计约束：
 *
 *  1. **setTimeout 链，不用 setInterval**（与 poller 同一原则）：上一轮清理
 *     没结束就不再排下一轮，避免慢库上叠加成并发删除。间隔 = 每日一次。
 *  2. **首轮延迟**：不在启动瞬间清理 —— bootstrap 同时在做迁移与恢复，
 *     再叠加一轮全表扫描会把冷启动拖长。默认 10s 后再跑首轮。
 *  3. **分批 + 轮次上限**：每批 ≤ `PURGE_BATCH_SIZE`（500 行），循环删到返回 0；
 *     但整轮最多 `PURGE_MAX_ROUNDS` 轮 —— 病态数据量（首次接入历史数据）下
 *     不能让清理任务长时间占着数据库，剩下的留给下一次。
 *
 * 失败不中断链条：单轮失败只告警并照常排下一轮（清理是「不紧急但必须发生」的
 * 后台动作，一次失败不能让它永久停摆）。
 */
import type { WelinkRepository } from '@/infra/db'
import { welink } from '@/infra/db'
import { AGENT_LOG_KEEP_DAYS, PURGE_BATCH_SIZE, RETENTION_KEEP_DAYS } from '@/infra/db/ports'
import { logger } from '@/utils/logger'
import { nowStamp } from '@/utils/time'
import { realTimers, type TimerApi } from './timers'

/** 每日一次（生产间隔） */
export const RETENTION_INTERVAL_MS = 24 * 60 * 60 * 1000

/** 首轮延迟：避开冷启动的迁移/恢复高峰期 */
export const RETENTION_FIRST_DELAY_MS = 10 * 1000

/** 单次清理的批数上限（500 × 20 = 单轮最多删 1 万行，剩余留待下次） */
export const PURGE_MAX_ROUNDS = 20

const DAY_MS = 24 * 60 * 60 * 1000

/** 一轮清理的结果（日志与测试断言用） */
export interface RetentionReport {
  /** 删除的消息条数 */
  messages: number
  /** 删除的 Agent 语料条数 */
  agentLogs: number
  /** 是否触到轮次上限（说明还有剩余，等下一轮） */
  capped: boolean
}

export interface RetentionOptions {
  repo?: WelinkRepository
  timers?: TimerApi
  now?: () => Date
  /** 距首轮清理的延迟（测试传 0） */
  firstDelayMs?: number
  /** 两轮清理之间的间隔（测试传小值） */
  intervalMs?: number
  /** 保留天数覆盖（测试用；生产用仓储层常量） */
  keepDays?: { messages: number; agentLogs: number }
}

export interface Retention {
  /** 启动清理链（幂等；已在运行时不重复排程） */
  start(): void
  /** 停止（清定时器；已在跑的清理让其自然结束且不再续排） */
  stop(): void
  running(): boolean
  /** 立即跑一轮（手动触发 / 测试直接断言，与自动链共用 single-flight） */
  runOnce(): Promise<RetentionReport>
  /** 上次清理结果（监控页可展示「上次清理删了多少」） */
  lastReport(): RetentionReport | null
}

export function createRetention(options: RetentionOptions): Retention {
  const repo = options.repo ?? welink()
  const timers = options.timers ?? realTimers
  const now = options.now ?? (() => new Date())
  const firstDelayMs = options.firstDelayMs ?? RETENTION_FIRST_DELAY_MS
  const intervalMs = options.intervalMs ?? RETENTION_INTERVAL_MS
  const keep = options.keepDays ?? { messages: RETENTION_KEEP_DAYS, agentLogs: AGENT_LOG_KEEP_DAYS }

  let timer: unknown = null
  let disposed = false
  let inFlight: Promise<RetentionReport> | null = null
  let report: RetentionReport | null = null

  /** 截止时刻（含 T 之前的都过期）：与落库口径一致，都是本地时间字符串 */
  function cutoffBefore(days: number): string {
    return nowStamp(new Date(now().getTime() - days * DAY_MS))
  }

  /**
   * 分批删到干净，或删满 `PURGE_MAX_ROUNDS` 轮。
   *
   * `purge` 返回本批删除行数：等于批量说明「很可能还有」，继续下一轮；
   * 小于批量说明已清空，可以停。返回 0 自然收敛。
   */
  async function purgeAll(
    purge: (cutoff: string, batch: number) => Promise<number>,
    cutoff: string,
  ): Promise<{ removed: number; capped: boolean }> {
    let removed = 0
    for (let round = 0; round < PURGE_MAX_ROUNDS; round += 1) {
      const count = await purge(cutoff, PURGE_BATCH_SIZE)
      removed += count
      if (count < PURGE_BATCH_SIZE) return { removed, capped: false }
    }
    return { removed, capped: true }
  }

  async function doRun(): Promise<RetentionReport> {
    const messageCutoff = cutoffBefore(keep.messages)
    const logCutoff = cutoffBefore(keep.agentLogs)
    const [messages, agentLogs] = await Promise.all([
      purgeAll((cutoff, batch) => repo.purgeMessagesBefore(cutoff, batch), messageCutoff),
      purgeAll((cutoff, batch) => repo.purgeAgentLogsBefore(cutoff, batch), logCutoff),
    ])
    const result: RetentionReport = {
      messages: messages.removed,
      agentLogs: agentLogs.removed,
      capped: messages.capped || agentLogs.capped,
    }
    report = result
    if (result.messages || result.agentLogs) {
      logger.info(
        `WeLink：保留期清理完成（消息 -${result.messages} 条 / 语料 -${result.agentLogs} 条；` +
          `保留消息 ${keep.messages} 天、语料 ${keep.agentLogs} 天）` +
          (result.capped ? '，本轮触上限，剩余留待下次' : ''),
      )
    }
    return result
  }

  /**
   * single-flight：手动触发与自动轮次不会同时删（同一批行被两条 DELETE 争抢
   * 只会白白产生锁等待）。后到者直接复用进行中那一次的结果。
   */
  function runOnce(): Promise<RetentionReport> {
    if (inFlight) return inFlight
    inFlight = doRun().finally(() => {
      inFlight = null
    })
    return inFlight
  }

  function schedule(delayMs: number) {
    if (disposed) return
    timer = timers.set(() => {
      timer = null
      void runOnce()
        .catch((error) => {
          // 清理失败不能中断链条，否则库坏一次它就永久停摆
          logger.warn(
            `WeLink：保留期清理失败（下次仍会重试）：${error instanceof Error ? error.message : String(error)}`,
          )
        })
        .finally(() => schedule(intervalMs))
    }, delayMs)
  }

  return {
    start() {
      if (disposed) return
      if (timer !== null || inFlight) return
      schedule(firstDelayMs)
    },

    stop() {
      disposed = true
      if (timer !== null) {
        timers.clear(timer)
        timer = null
      }
    },

    running() {
      return !disposed && timer !== null
    },

    runOnce,

    lastReport() {
      return report
    },
  }
}
