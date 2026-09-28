/**
 * 轮询节奏预算（poller 与设置页**共用同一份算法**）。
 *
 * 解决的问题（D-6）：`staggerMs`（默认 2s）是**每会话**错峰，而 `pollIntervalSec`
 * （默认 5s）是**整轮**间隔 —— 两种量纲。20 个监控会话时单轮光错峰就要 38s，
 * 用户把间隔调到 3s 也看不到 3s 的效果。「参数写了却不生效」比「参数不够快」
 * 更坏：用户会去怀疑开关坏了，而不是怀疑量纲不同。
 *
 * ## 四条规则（按优先级，改动时勿破坏）
 *
 *  1. **不超过配置上限**：`perConv ≤ cap`。用户（或测试）把错峰关掉/调小时，
 *     这里不能自作主张加回去。
 *  2. **绝不为 0**（N > 1 时）：错峰的原始目的是「别在同一刻连开 N 个 CLI 进程」。
 *     收敛可以把它压小，但不能取消 —— 所以有保底 [`POLL_STAGGER_MIN_MS`]。
 *  3. **优先让总额装进一轮间隔**：`perConv = min(cap, 间隔 / (N-1))`。
 *     这是让 `pollIntervalSec` 恢复意义的关键一步。
 *  4. **保底优先于规则 3，但总额有硬顶**：当会话多到 `间隔/(N-1)` 低于保底时，
 *     **保底赢**（进程风暴比「轮询比预期慢」更糟），代价是单轮会比间隔长 ——
 *     此时由设置页如实显示实际周期（`converged = true`）。
 *     同时总额受 [`POLL_STAGGER_TOTAL_MAX_MS`] 硬顶，避免 1000 个会话把单轮
 *     拖成几分钟。
 *
 * 规则 3 与 4 的取舍是刻意的：**无法同时满足「间隔 3s」与「100 个会话各错峰
 * 300ms」**（后者物理上就要 29.7s）。与其悄悄牺牲一个，不如保底保护 + 明说数字。
 *
 * 为什么要单独抽一个纯函数而不是让 poller 自己算：设置页必须能**如实**告诉用户
 * 「实际周期是多少」。两处各算一份必然漂移，然后页面上的数字就成了谎话。
 */

/** 单会话错峰的**配置上限**（可被 `staggerMs` 选项/测试覆盖） */
export const POLL_STAGGER_MS = 2000

/**
 * 动态收敛后的**每会话错峰保底**（毫秒）。
 *
 * 为什么是 300ms 而不是 0：本机 CLI 进程创建 + 单次拉取通常在数百毫秒量级，
 * 300ms 已足以把「同一刻爆一串进程」摊开。收敛的目的是让「间隔」恢复意义，
 * 不是取消错峰（见头部规则 4）。
 */
export const POLL_STAGGER_MIN_MS = 300

/**
 * 错峰**总额**硬顶（毫秒）。
 *
 * 为什么需要：保底优先于「装进间隔」意味着会话数越多单轮越长。若不加硬顶，
 * `WATCHING_HARD_LIMIT`（1000）个会话会产生 300s 的单轮错峰 —— 那不是「保护
 * 进程」，而是把轮询功能停掉。30s 的选择：超过这个量级，用户应该去拆监控清单
 * 而不是等一轮。
 */
export const POLL_STAGGER_TOTAL_MAX_MS = 30_000

/**
 * 本轮实际使用的**每会话错峰**（毫秒）。
 *
 * @param baseIntervalMs 本轮基准间隔（已含隐藏/退避系数），作为错峰总预算
 * @param conversationCount 本轮**实际要拉取**的会话数（分级轮询过滤之后的数）
 * @param configuredMs 配置的错峰上限；传 0 表示关闭错峰（测试用）
 */
export function effectiveStaggerMs(
  baseIntervalMs: number,
  conversationCount: number,
  configuredMs: number = POLL_STAGGER_MS,
): number {
  const count = Math.floor(conversationCount)
  // 规则 1 + 2：开关关掉时不产生错峰；会话 ≤1 时没有「之间」可言
  if (configuredMs <= 0 || count <= 1) return 0

  const gaps = count - 1
  const budgetPerConv = Math.max(0, baseIntervalMs) / gaps
  // 规则 3：先尝试装进间隔（同时受配置上限约束）
  const withinBudget = Math.min(configuredMs, budgetPerConv)
  // 规则 4：保底 —— 但保底本身也不能突破「总额硬顶」
  const floor = Math.min(POLL_STAGGER_MIN_MS, configuredMs, POLL_STAGGER_TOTAL_MAX_MS / gaps)
  const perConv = Math.max(withinBudget, floor)
  // 规则 1 的最终兜底：保底来自常量，配置更小时仍以配置为准
  return Math.round(Math.min(configuredMs, perConv))
}

/** 一轮轮询的节奏预估（设置页把「实际周期」讲清楚的数据源） */
export interface PollRoundPlan {
  /** 参与本轮的会话数 */
  conversationCount: number
  /** 每会话实际错峰（毫秒，已收敛） */
  staggerMs: number
  /** 错峰总耗时（毫秒）：`(N-1) × staggerMs` */
  staggerTotalMs: number
  /** 单轮墙钟耗时下限（毫秒）。**不含拉取本身耗时** —— 那是外部进程决定的，估不准 */
  roundMs: number
  /** 实际周期下限（毫秒）：轮间隔 + 单轮耗时 */
  periodMs: number
  /**
   * 是否发生了收敛（配置的错峰被会话数压小）。
   *
   * UI 据此给出解释文案。会话 ≤1 或无错峰时恒为 `false` —— 那种情况下
   * 「收敛」无从谈起，标记为 true 只会让页面显示一句无意义的说明。
   */
  converged: boolean
}

export interface PollRoundPlanInput {
  /** 用户配置的轮询间隔（秒） */
  intervalSec: number
  /** 监控中的会话数 */
  conversationCount: number
  /** 配置的错峰上限（默认 [`POLL_STAGGER_MS`]） */
  configuredStaggerMs?: number
  /** 窗口隐藏系数（P9，隐藏时 3） */
  hiddenFactor?: number
  /** 有会话退避时的整轮放大系数（D-4 的有上界折中） */
  backoffFactor?: number
}

/**
 * 预估一轮轮询的实际节奏。
 *
 * 刻意**不猜拉取耗时**：CLI 进程创建 + 网络往返由外部环境决定，写死一个数
 * 会让页面上的「实际周期」再次变成谎话。这里只给**下限**（错峰是可精确计算的
 * 那一部分），并明确标注「不含拉取耗时」。
 */
export function planPollRound(input: PollRoundPlanInput): PollRoundPlan {
  const configured = input.configuredStaggerMs ?? POLL_STAGGER_MS
  const count = Math.max(0, Math.floor(input.conversationCount))
  const base = Math.max(0, input.intervalSec) * 1000 * (input.hiddenFactor ?? 1) * (input.backoffFactor ?? 1)
  const staggerMs = effectiveStaggerMs(base, count, configured)
  const staggerTotalMs = Math.max(0, count - 1) * staggerMs
  return {
    conversationCount: count,
    staggerMs,
    staggerTotalMs,
    roundMs: staggerTotalMs,
    periodMs: base + staggerTotalMs,
    converged: count > 1 && configured > 0 && staggerMs < configured,
  }
}
