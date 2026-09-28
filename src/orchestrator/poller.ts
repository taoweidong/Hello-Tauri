/**
 * 轮询器（设计 §5-P2 / §6.1 / §5B.1-O2）。
 *
 * 三条硬约束，改动时勿破坏：
 *
 *  1. **single-flight + setTimeout 链**（P2）：弃用 `setInterval`（上一轮未完会叠加），
 *     本轮**完成**（含失败）之后才排下一轮定时器。「立即拉取」与自动轮询共用同一把锁，
 *     因此连点按钮不会打出并发请求 —— 这是「手动与自动天然去重」的实现。
 *  2. **分级自适应轮询**（O2）：轮询一轮 = 拉取全部监控会话，20 个群就是 20 次 CLI 进程
 *     创建。按 `last_active` 分三级：热（30min 内）每轮拉、温（24h 内）每 3 轮、
 *     冷（更早）每 6 轮或仅手动。会话间错峰（`staggerMs`，**按会话数动态收敛**，
 *     见下方 D-6 说明），避免同一刻爆进程。
 *  3. **每轮业务判定下沉到仓储**（P4）：触发表由 `buildTriggerMap` 算出后传给
 *     `applyPollResult`，消息批写 + cursor 推进 + 建 job + 汇总列维护在**一个事务**里完成。
 *
 * 失败处理：单会话失败不中断整轮（其他会话照常），该会话进入**各会话独立的退避**
 * （5/10/20/40/60s），状态经事件推给 UI 左栏的状态小点。
 */
import { welinkClient } from '@/infra/welink'
import type { WelinkPort } from '@/infra/welink'
import type { WelinkRepository } from '@/infra/db'
import type { NormalizedMessage, TriggerType, WelinkConversation, WelinkSettings } from '@/types/welink'
import { logger } from '@/utils/logger'
import { nowStamp, parseStamp } from '@/utils/time'
import { POLL_STAGGER_MS, effectiveStaggerMs } from '@/utils/poll'
import { emptySummary, type ConversationState, type EventSink, type PollSummary } from './events'
import { realTimers, type TimerApi } from './timers'
import { buildTriggerMap } from './triggers'

/** 退避序列（秒）：失败次数越多等得越久，封顶 60s */
export const BACKOFF_STEPS = [5, 10, 20, 40, 60] as const

/** 分级轮询阈值（O2） */
export const HOT_WINDOW_MS = 30 * 60 * 1000
export const WARM_WINDOW_MS = 24 * 60 * 60 * 1000
/** 温会话每 N 轮拉一次；冷会话每 N 轮拉一次 */
export const WARM_EVERY = 3
export const COLD_EVERY = 6

/** 有会话在退避时整轮间隔的放大系数（**有上界**，见 `baseIntervalMs` 的 D-4 说明） */
export const BACKOFF_ROUND_FACTOR = 2

/** 同一事务内续批上限（P8）：hasMore=true 时最多再拉 2 批，剩余留待下轮 */
export const CONTINUE_BATCHES = 3

export interface PollerOptions {
  repo: WelinkRepository
  /** 设置读取函数（每次调用取最新值，配置改动即时生效） */
  settings: () => WelinkSettings
  emit: EventSink
  timers?: TimerApi
  now?: () => Date
  /**
   * 会话间错峰的**每会话**期望间隔（毫秒）。
   *
   * D-6 后语义变了：这里是**上限**而不是定值 —— 实际值由
   * `effectiveStaggerMs(本轮间隔, 本轮会话数, 本值)` 收敛，保证「错峰总耗时」
   * 不超过一轮间隔。测试传 0 表示完全关闭错峰。
   */
  staggerMs?: number
  /** 端口获取函数（默认走工厂；测试注入 mock 端口） */
  client?: (settings: WelinkSettings) => WelinkPort
}

export interface Poller {
  /** 启动轮询链（幂等；已在运行时不重复排程） */
  start(): void
  /** 停止（清 timer + 标记 disposed；已在飞的轮询让其自然结束） */
  stop(): void
  running(): boolean
  /**
   * 立即拉取一轮（与自动轮询共用 in-flight 锁）。
   * 返回本轮摘要 —— UI 的 toast「新增 N 条、命中 M 条待回复」由此而来。
   */
  pullNow(): Promise<PollSummary>
  /** 监控清单变更后热更新（下一轮生效；不打断进行中的轮询） */
  refreshConversations(): Promise<void>
  /** 窗口可见性（P9）：隐藏时轮询间隔 ×3 */
  setVisible(visible: boolean): void
  /** 某会话的拉取健康度（UI 状态小点） */
  conversationState(convId: string): ConversationState
  /** 当前轮次计数（UI 状态灯「退避中（第 n 轮）」） */
  round(): number
  /**
   * 本轮实际使用的每会话错峰（毫秒）。
   *
   * 暴露出来是为了让**设置页显示的数字与实际执行的一致**（D-6）。`null` 表示
   * 还没有跑过任何一轮，此时按配置与会话数估算（见 `utils/poll.ts` 的
   * `planPollRound`）。
   */
  currentStaggerMs(): number | null
}

export function createPoller(options: PollerOptions): Poller {
  const timers = options.timers ?? realTimers
  const now = options.now ?? (() => new Date())
  /** 错峰配置**上限**（D-6）。实际每会话值由 `effectiveStaggerMs` 按会话数收敛。 */
  const staggerCapMs = options.staggerMs ?? POLL_STAGGER_MS
  const client = options.client ?? ((settings: WelinkSettings) => welinkClient({ settings }))

  let timer: unknown = null
  let running = false
  let visible = true
  let roundNo = 0
  /** 上一轮实际使用的每会话错峰（D-6：供设置页显示真实值，null = 还没跑过） */
  let lastStaggerMs: number | null = null
  /** in-flight 锁：整个轮询循环只有一把 —— 手动与自动共用（P2） */
  let inFlight: Promise<PollSummary> | null = null
  /** 各会话退避状态（不随监控清单增删而清空，便于观察「曾经的坏会话」） */
  const states = new Map<string, ConversationState & { nextAllowedAt: number }>()

  function stateOf(convId: string): ConversationState & { nextAllowedAt: number } {
    let state = states.get(convId)
    if (!state) {
      state = { state: 'ok', failCount: 0, backoffSec: 0, reason: '', lastOkAt: '', nextAllowedAt: 0 }
      states.set(convId, state)
    }
    return state
  }

  /** 排下一轮（先清旧句柄，避免重复定时器堆积） */
  function scheduleNext(delayMs: number) {
    if (!running) return
    timers.clear(timer)
    timer = timers.set(
      () => {
        timer = null
        void runRound(false)
      },
      Math.max(0, delayMs),
    )
  }

  /**
   * 本轮间隔：基准 × 隐藏系数（P9）× 退避放大系数。
   *
   * **为什么不能用「所有会话里最大的 backoffSec」**（D-4 修掉的真实缺陷）：
   * 退避是**会话级**的 —— `runRound` 里已经用 `state.nextAllowedAt > nowMs` 逐会话
   * 判断（见其上方注释）。若这里再把最差退避放大到整轮间隔，就是**同一个机制罚两次**：
   * 一个坏会话进入 60s 退避后，全部健康会话（本可 5s 一轮）被一起拖慢 12 倍，
   * 而且失败会话越多整体越慢 —— 与「单会话失败不中断整轮」的设计初衷正好相反。
   *
   * 替代方案是**有上界**的折中：只要还有会话在退避，整轮间隔就翻 [`BACKOFF_ROUND_FACTOR`]
   * 倍（封顶 2 倍），既保留「别在坏会话上每小时空转」的意图，又不会让健康会话
   * 被无限期拖着。真正该等多久，由每个会话自己的 `nextAllowedAt` 决定。
   */
  function baseIntervalMs(): number {
    const base = options.settings().pollIntervalSec * 1000
    const hiddenFactor = visible ? 1 : 3
    let anyBackoff = false
    for (const state of states.values()) {
      if (state.backoffSec > 0) {
        anyBackoff = true
        break
      }
    }
    return base * hiddenFactor * (anyBackoff ? BACKOFF_ROUND_FACTOR : 1)
  }

  /** 分级判定（O2）：该会话本轮是否值得拉 */
  function shouldPoll(conv: WelinkConversation): boolean {
    const active = parseStamp(conv.lastActive)
    // 从未有消息：视为热（首次导入的会话必须立刻拉一批，否则用户看不到任何数据）
    if (!active) return true
    const age = now().getTime() - active.getTime()
    if (age <= HOT_WINDOW_MS) return true
    if (age <= WARM_WINDOW_MS) return roundNo % WARM_EVERY === 1
    return roundNo % COLD_EVERY === 1
  }

  async function runRound(manual: boolean): Promise<PollSummary> {
    if (inFlight) return inFlight
    const task = (async (): Promise<PollSummary> => {
      const settings = options.settings()
      const summary = emptySummary()
      roundNo += 1
      options.emit({ type: 'roundStarted', round: roundNo })

      // 初值不给空数组：失败分支直接 return，空数组永远不会被读到，
      // 留着会让人误以为「读失败时按空清单继续跑」（实际不是）。TS 的
      // 明确赋值检查在这个形态下能正确判定赋值完备。
      let conversations: WelinkConversation[]
      try {
        conversations = await options.repo.listWatching()
      } catch (error) {
        logger.error('轮询：读取监控清单失败', error)
        options.emit({ type: 'roundFinished', round: roundNo, summary })
        return summary
      }
      summary.conversations = conversations.length

      const port = client(settings)
      const nowMs = now().getTime()

      /**
       * 先算出**本轮真正要拉**的会话（D-6 的关键：错峰按实际拉取数收敛，
       * 而不是监控总数）。
       *
       * 为什么必须两趟：分级轮询（O2）会跳过温/冷会话，20 个监控会话在某一轮
       * 可能只有 3 个要拉。若按 20 收敛，错峰会被压得过小（白留着空隙）；按 20
       * 铺开又不成立（其余 17 个本轮根本不拉，谈不上「错峰」）。先过滤再收敛，
       * 页面显示的预估数字也才能与实际一致。
       */
      const due = conversations.filter((conv) => {
        const state = stateOf(conv.convId)
        // 退避未到期 → 跳过（手动拉取也尊重退避：失败会话立刻重试只会继续失败）
        if (state.nextAllowedAt > nowMs) return false
        if (!manual && !shouldPoll(conv)) return false
        return true
      })

      /**
       * 本轮每会话错峰（D-6）。
       *
       * 语义变化：`staggerMs` 从「定值」改为「上限」。总额收敛到本轮间隔之内，
       * 会话越多每个间隔越小（有地板，见 `utils/poll.ts`）。这样
       * `pollIntervalSec` 才恢复成「用户能感知的周期」—— 而不是被 20 × 2s 淹没。
       * 基准用 `baseIntervalMs()`：隐藏窗口（×3）时预算同步放宽，不必额外收敛。
       */
      const roundStaggerMs = effectiveStaggerMs(baseIntervalMs(), due.length, staggerCapMs)
      lastStaggerMs = roundStaggerMs

      for (const conv of due) {
        const state = stateOf(conv.convId)

        // 会话间错峰（O2）：CLI 进程创建要留出间隔
        if (summary.polled > 0 && roundStaggerMs > 0) await delay(roundStaggerMs, timers)

        summary.polled += 1
        try {
          const result = await pollConversation(conv, port, settings)
          summary.inserted += result.inserted
          summary.jobs += result.jobs
          state.state = 'ok'
          state.failCount = 0
          state.backoffSec = 0
          state.reason = ''
          state.lastOkAt = nowStamp(now())
          state.nextAllowedAt = 0
          options.emit({ type: 'conversationState', convId: conv.convId, state: { ...state } })
        } catch (error) {
          summary.failed += 1
          state.failCount += 1
          state.backoffSec = BACKOFF_STEPS[Math.min(state.failCount - 1, BACKOFF_STEPS.length - 1)]
          state.state = 'backoff'
          state.reason = error instanceof Error ? error.message : String(error)
          state.nextAllowedAt = nowMs + state.backoffSec * 1000
          options.emit({ type: 'conversationState', convId: conv.convId, state: { ...state } })
          logger.warn(
            `轮询失败（${conv.title || conv.convId}，第 ${state.failCount} 次，退避 ${state.backoffSec}s）：${state.reason}`,
          )
        }
      }

      options.emit({ type: 'roundFinished', round: roundNo, summary })
      return summary
    })()

    inFlight = task
    try {
      return await task
    } finally {
      inFlight = null
      // 完成（含失败）后才排下一轮 —— P2 的核心语义
      if (running) scheduleNext(baseIntervalMs())
    }
  }

  /**
   * 单个会话：拉取 → 归一化过滤 → 触发表 → 单事务入库。
   * 返回本会话新增消息与新建任务数。
   *
   * P8 的续批语义：`hasMore=true` 时继续拉，但**批次内的消息合并成一次
   * `applyPollResult`**（一个事务完成批写 + cursor + 建 job + 汇总列），
   * 而不是每批一个事务 —— 后者在消息洪峰时会打出 N 倍 IPC 往返与 N 次事务提交。
   * 上限仍是 `CONTINUE_BATCHES` 批，剩余留给下一轮，避免单轮无限拉取饿死其他会话。
   */
  async function pollConversation(
    conv: WelinkConversation,
    port: WelinkPort,
    settings: WelinkSettings,
  ): Promise<{ inserted: number; jobs: number }> {
    let cursor = conv.lastCursor
    /** 本会话本轮累计待入库的消息（跨续批累积，最后一次性提交） */
    const pending: NormalizedMessage[] = []

    for (let batch = 0; batch < CONTINUE_BATCHES; batch += 1) {
      const pulled = await port.pull(conv, cursor, settings.pullBatchLimit)
      if (pulled.messages.length) pending.push(...pulled.messages)
      cursor = pulled.cursor
      if (!pulled.hasMore) break
    }
    if (!pending.length) return { inserted: 0, jobs: 0 }

    // 跨续批去重：CLI 的分页边界可能重复上一批的最后一条（cursor 不透明，
    // 真实接口未定型）。msg_uid 是幂等键，这里先在本轮内收敛，避免把重复行
    // 带进触发表导致同一条消息建出两个 job。
    const unique = new Map<string, NormalizedMessage>()
    for (const message of pending) if (!unique.has(message.msgUid)) unique.set(message.msgUid, message)
    const messages = [...unique.values()]

    const fresh = filterSelf(messages, settings.myUserId)
    const { triggers } = buildTriggerMap(fresh, {
      watching: conv.watching,
      myUserId: settings.myUserId,
      groupAtMe: settings.trigger.groupAtMe,
      privateAutoReply: settings.trigger.privateAutoReply,
      // S5 同人短窗合并：在建任务阶段收敛，保证「一次回复、上下文含全部触发」
      mergeWindowSec: settings.safety.mergeWindowSec,
    })
    const applied = await options.repo.applyPollResult(conv.convId, fresh, cursor, {
      triggers,
      sendMode: settings.sendMode,
    })
    if (applied.inserted.length) {
      options.emit({ type: 'messagesAppended', convId: conv.convId, messages: applied.inserted })
      // 本会话有了新数据 → 立刻是热的，后续轮次不再被分级跳过
      conv.lastActive = nowStamp(now())
    }
    for (const job of applied.createdJobs) options.emit({ type: 'jobCreated', job })

    return { inserted: applied.inserted.length, jobs: applied.createdJobs.length }
  }

  return {
    start() {
      if (running) return
      running = true
      logger.info(`WeLink 轮询已启动（基准间隔 ${options.settings().pollIntervalSec}s）`)
      // 首轮不等待：用户点开总开关应当立刻看到数据
      void runRound(false)
    },

    stop() {
      running = false
      timers.clear(timer)
      timer = null
      logger.info('WeLink 轮询已停止（数据与未完成任务保留）')
    },

    running() {
      return running
    },

    pullNow() {
      // 与自动轮询共用 in-flight：连点按钮只会执行一次，第二次拿到同一个 Promise
      return runRound(true)
    },

    async refreshConversations() {
      // 清单热更新的成本只在下一轮体现（listWatching 每轮都重新读一次），
      // 这里显式清掉「已删除会话」的退避状态，避免状态表无限增长。
      try {
        const list = await options.repo.listWatching()
        const alive = new Set(list.map((conv) => conv.convId))
        for (const convId of [...states.keys()]) {
          if (!alive.has(convId)) states.delete(convId)
        }
        options.emit({ type: 'conversationsChanged', convIds: list.map((conv) => conv.convId) })
      } catch (error) {
        logger.error('刷新监控清单失败', error)
      }
      // 已排的下一轮时间可能过长（刚新增会话时希望立刻拉），重排一次
      if (running && !inFlight) scheduleNext(0)
    },

    setVisible(next) {
      if (visible === next) return
      visible = next
      // 立刻按新系数重排（P9：显示即恢复）
      if (running && !inFlight) scheduleNext(0)
    },

    conversationState(convId) {
      const state = stateOf(convId)
      return {
        state: state.state,
        failCount: state.failCount,
        backoffSec: state.backoffSec,
        reason: state.reason,
        lastOkAt: state.lastOkAt,
      }
    },

    round() {
      return roundNo
    },

    currentStaggerMs() {
      return lastStaggerMs
    },
  }
}

/**
 * 自发消息过滤（§7.1 最后一行）：`senderId == myUserId` 的消息标记为 out。
 *
 * 为什么要在这里改 direction 而不是丢弃：私聊要求「双向存档」（R2），
 * 自己发出的消息也要出现在时间线里；但**绝不能**因此建回复任务（自回复死循环）。
 * 改 direction 后，`buildTriggerMap` 会因 `direction === 'out'` 直接不建任务。
 */
export function filterSelf(messages: NormalizedMessage[], myUserId: string): NormalizedMessage[] {
  if (!myUserId) return messages
  return messages.map((message) =>
    message.senderId === myUserId && message.direction === 'in' ? { ...message, direction: 'out' } : message,
  )
}

/** 可注入的 sleep（沿用 TimerApi，测试传 0 时不排真实定时器） */
function delay(ms: number, timers: TimerApi): Promise<void> {
  if (ms <= 0) return Promise.resolve()
  return new Promise((resolve) => timers.set(resolve, ms))
}

export type { TriggerType }
