/**
 * 保留期清理（设计 §8 / §10；质量报告 D-1 + S-4）。
 *
 * 为什么必须有这一层：`RETENTION_KEEP_DAYS` / `PURGE_BATCH_SIZE` /
 * `purgeMessagesBefore` / `purgeAgentLogsBefore` 都是**早就写好但无人调用**的能力 ——
 * 于是 `welink_messages` 与 `welink_agent_logs` 无界增长。桌面应用是长跑场景
 * （每分钟一轮轮询、每轮可能入库几十条），千级数据时察觉不到，上线三个月后
 * 所有列表查询一起变慢。清理任务缺的不是实现，是**调度**。
 *
 * 同一个毛病在沉淀域又犯了一次（v6 引入的 `sediment_logs`：接口写好了、无人调用、
 * 且实现是无 LIMIT 的全表 DELETE）—— 第五轮把它改成按时间分批并接进本清理链，
 * 留痕保留期 30 天（单条可达 10 KB，是三张表里单位体积最大的一张）。
 *
 * 公告是第四次（v12 补索引 + `purgeAnnouncementsBefore`，保留期 90 天）。
 *
 * 第七轮补的是**回复任务本身**（`welink_reply_jobs`，保留期 180 天）—— 它才是最该清的一张：
 * 写入最频繁，且**清理它才让消息保留期真正生效**（`purgeMessagesBefore` 会跳过仍被 job
 * 引用的消息，job 不清理 ⇒ 那些消息永不过期）。详见 `ports.JOB_KEEP_DAYS` 的注释。
 *
 * 第八轮补的是**待评审知识条目**（`knowledge_drafts`，v13 补索引 +
 * `purgeKnowledgeDraftsBefore`，保留期 90 天）—— approved/rejected 只标记不删除，
 * 终态痕迹永久驻留。注意它**只清已决状态**：pending 是用户的评审待办，绝不可碰。
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
 *
 * **`stop()` 是暂停不是终态**（与 `codehub-sync.stopAuto()` 同语义）：关总开关后
 * `start()` 必须能重新排程，否则「一次 stop 就永久停摆」会让本模块形同虚设 ——
 * 而由于清理失败只走 `.catch` 告警，这类停摆是**静默**的，用户毫无感知。
 * 永久销毁另有`dispose()`。
 */
import type { WelinkRepository } from '@/infra/db'
import { sediment, welink } from '@/infra/db'
import type { SedimentRepository } from '@/infra/db/sediment-ports'
import {
  AGENT_LOG_KEEP_DAYS,
  ANNOUNCEMENT_KEEP_DAYS,
  JOB_KEEP_DAYS,
  KNOWLEDGE_DRAFT_KEEP_DAYS,
  PURGE_BATCH_SIZE,
  RETENTION_KEEP_DAYS,
  SEDIMENT_LOG_KEEP_DAYS,
} from '@/infra/db/ports'
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
  /** 删除的过期回复任务条数（只清终态，见 `ports.JOB_KEEP_DAYS`） */
  jobs: number
  /** 删除的消息条数 */
  messages: number
  /** 删除的 Agent 语料条数 */
  agentLogs: number
  /** 删除的沉淀提取留痕条数 */
  sedimentLogs: number
  /** 删除的群公告条数 */
  announcements: number
  /** 删除的已决待评审条目条数（只清 approved/rejected，见 `ports.KNOWLEDGE_DRAFT_KEEP_DAYS`） */
  knowledgeDrafts: number
  /** 是否触到轮次上限（说明还有剩余，等下一轮） */
  capped: boolean
}

export interface RetentionOptions {
  repo?: WelinkRepository
  /** 沉淀仓储（留痕与公告清理用）；缺省取全局工厂，测试可注入 */
  sedimentRepo?: SedimentRepository
  timers?: TimerApi
  now?: () => Date
  /** 距首轮清理的延迟（测试传 0） */
  firstDelayMs?: number
  /** 两轮清理之间的间隔（测试传小值） */
  intervalMs?: number
  /**
   * 保留天数覆盖（测试用；生产用仓储层常量）。
   * `sedimentLogs` / `announcements` 可省，缺省 30 / 90 天。
   */
  keepDays?: {
    messages: number
    agentLogs: number
    sedimentLogs?: number
    announcements?: number
    jobs?: number
    knowledgeDrafts?: number
  }
}

export interface Retention {
  /** 启动清理链（幂等；已在运行时不重复排程） */
  start(): void
  /**
   * 停止自动链（清定时器；已在跑的清理让其自然结束且不再续排）。
   *
   * **可重启**：`start()` 之后会重新排程 —— 这是「暂停」语义，与 `dispose()` 相对。
   */
  stop(): void
  /** 永久销毁（终态；`start()` 不再生效）。仅在明确要丢弃这个实例时使用 */
  dispose(): void
  running(): boolean
  /** 立即跑一轮（手动触发 / 测试直接断言，与自动链共用 single-flight） */
  runOnce(): Promise<RetentionReport>
  /** 上次清理结果（监控页可展示「上次清理删了多少」） */
  lastReport(): RetentionReport | null
}

export function createRetention(options: RetentionOptions): Retention {
  const repo = options.repo ?? welink()
  const sedimentRepo = options.sedimentRepo ?? sediment()
  const timers = options.timers ?? realTimers
  const now = options.now ?? (() => new Date())
  const firstDelayMs = options.firstDelayMs ?? RETENTION_FIRST_DELAY_MS
  const intervalMs = options.intervalMs ?? RETENTION_INTERVAL_MS
  const keep = options.keepDays ?? { messages: RETENTION_KEEP_DAYS, agentLogs: AGENT_LOG_KEEP_DAYS }
  const sedimentKeepDays = options.keepDays?.sedimentLogs ?? SEDIMENT_LOG_KEEP_DAYS
  const announcementKeepDays = options.keepDays?.announcements ?? ANNOUNCEMENT_KEEP_DAYS
  const jobKeepDays = options.keepDays?.jobs ?? JOB_KEEP_DAYS
  const draftKeepDays = options.keepDays?.knowledgeDrafts ?? KNOWLEDGE_DRAFT_KEEP_DAYS

  let timer: unknown = null
  let disposed = false
  /**
   * 自动链是否在跑（`start()` 置真、`stop()`/`dispose()` 置假）。
   *
   * 为什么必须有这一位：`stop()` 只清了定时器，但**已在飞的那一轮**的
   * `.finally(() => schedule(intervalMs))` 仍会无条件续排下一轮 —— 于是
   * 「关了总开关，清理链却自己复活」。`stop()` 后 timer 被清、`running()` 为假、
   * 界面上也看不出来，下一轮却照删不误：这是**静默**的语义违约（文件头写的是
   * 「已在跑的清理让其自然结束且不再续排」）。判定只能靠显式状态位，
   * 不能靠「timer 是否为 null」推断（在飞轮次期间 timer 本就是 null）。
   */
  let chaining = false
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
    // 沉淀留痕此前**从未进过清理链**：接口写好了（旧 `clearSedimentLogs`）却无人调用，
    // 而它单条可达 10 KB（prompt + response），是三张表里**单位体积最大**的一张 ——
    // 长跑下最先失控的反而是它。这里与消息/语料同轮清理（依赖 migration v11 索引）。
    const sedimentCutoff = cutoffBefore(sedimentKeepDays)
    // 公告此前**从未进过清理链**：v6 建表至今既无保留期也无清理接口，是沉淀域里
    // 唯一一张「只增不减」的持续写入表（依赖 migration v12 的 created_at 索引）。
    const announcementCutoff = cutoffBefore(announcementKeepDays)
    const jobCutoff = cutoffBefore(jobKeepDays)
    // 待评审条目同样只增不减（第八轮）：insertDrafts 持续写入，approved/rejected
    // 只标记不删除。截止时刻按 reviewed_at（评审时刻）算 —— 与「删消息不删 job」
    // 同一条口径：删的是评审痕迹，产物在 knowledge/*.md 里，删痕迹不减产物。
    // 只清已决状态（purge 实现里显式限定），pending 永不被碰。
    const draftCutoff = cutoffBefore(draftKeepDays)
    //
    // 为什么串行而不是 `Promise.all`：文件头约束 1 写的就是「避免慢库上叠加成并发删除」。
    // 六条链各跑最多 20 轮 × 500 行，并发起来是六路写事务同时抢宿主的 SQLite 全局连接锁
    // （`db.rs` 的连接是全局 Mutex）—— 清理是后台动作，慢一点无所谓，把前台查询拖住才是问题。
    //
    // 顺序有讲究：**job 必须排在消息之前**。`purgeMessagesBefore` 的 `NOT EXISTS` 会跳过
    // 仍被 job 引用的消息，先清掉过期 job 才能让那批消息在本轮就满足删除条件；
    // 反过来的话它们要多等一整天。
    const jobs = await purgeAll((cutoff, batch) => repo.purgeJobsBefore(cutoff, batch), jobCutoff)
    const messages = await purgeAll((cutoff, batch) => repo.purgeMessagesBefore(cutoff, batch), messageCutoff)
    const agentLogs = await purgeAll((cutoff, batch) => repo.purgeAgentLogsBefore(cutoff, batch), logCutoff)
    const sedimentLogs = await purgeAll(
      (cutoff, batch) => sedimentRepo.purgeSedimentLogsBefore(cutoff, batch),
      sedimentCutoff,
    )
    const announcements = await purgeAll(
      (cutoff, batch) => sedimentRepo.purgeAnnouncementsBefore(cutoff, batch),
      announcementCutoff,
    )
    const knowledgeDrafts = await purgeAll(
      (cutoff, batch) => sedimentRepo.purgeKnowledgeDraftsBefore(cutoff, batch),
      draftCutoff,
    )
    const result: RetentionReport = {
      jobs: jobs.removed,
      messages: messages.removed,
      agentLogs: agentLogs.removed,
      sedimentLogs: sedimentLogs.removed,
      announcements: announcements.removed,
      knowledgeDrafts: knowledgeDrafts.removed,
      capped:
        jobs.capped ||
        messages.capped ||
        agentLogs.capped ||
        sedimentLogs.capped ||
        announcements.capped ||
        knowledgeDrafts.capped,
    }
    report = result
    if (result.messages || result.agentLogs || result.sedimentLogs || result.announcements || result.knowledgeDrafts) {
      logger.info(
        `WeLink：保留期清理完成（消息 -${result.messages} 条 / 语料 -${result.agentLogs} 条 / ` +
          `沉淀留痕 -${result.sedimentLogs} 条 / 公告 -${result.announcements} 条 / ` +
          `待评审痕迹 -${result.knowledgeDrafts} 条；保留消息 ` +
          `${keep.messages} 天、语料 ${keep.agentLogs} 天、留痕 ${sedimentKeepDays} 天、` +
          `公告 ${announcementKeepDays} 天、待评审痕迹 ${draftKeepDays} 天）` +
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
    if (disposed || !chaining) return
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
      if (disposed || chaining) return
      chaining = true
      // 在飞的轮次不必再排：它自己的 finally 会续排（此时 chaining 已为真）。
      // 若这里也排一个，两条链会同时存在并互相覆盖 timer 句柄。
      if (inFlight) return
      schedule(firstDelayMs)
    },

    stop() {
      // 只停「自动链」，不置disposed —— 这是**可重启**的暂停（与
      // `codehub-sync.stopAuto()` 同一语义）。用户关一次总开关再打开，
      // 清理器必须能重新排程；早期版本在这里置 `disposed = true` 且无复位入口，
      // 导致 `runtime.stop()` 一次之后本进程内再也不会清理，且无任何用户可见信号
      // —— 恰好废掉本模块存在的唯一理由（见文件头「为什么必须有这一层」）。
      // 永久销毁请用 `dispose()`。
      //
      // 置 `chaining = false` 是本轮修复的关键：只清定时器挡不住在飞轮次末尾的
      // `finally → schedule()`，那样「已停止」只是表象（见 `chaining` 声明处注释）。
      chaining = false
      if (timer !== null) {
        timers.clear(timer)
        timer = null
      }
    },

    /**
     * 永久销毁（`disposed` 不可复位，`start()` 之后也不会再排程）。
     *
     * 与 `stop()` 的区别就是「暂停 vs 终态」—— 调用方需明确意图，不要拿它当暂停用。
     * 当前生产路径没有调用方（runtime 的开关走 `stop()`），保留是为了让
     * 「销毁一个Retention 实例」这件事有明确表达，而不是靠「谁最后持有它」隐式决定。
     */
    dispose() {
      disposed = true
      chaining = false
      if (timer !== null) {
        timers.clear(timer)
        timer = null
      }
    },

    running() {
      return !disposed && chaining && timer !== null
    },

    runOnce,

    lastReport() {
      return report
    },
  }
}
