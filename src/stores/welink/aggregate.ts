/**
 * welink store 的纯派生层（quality-hardening-2026-10 D1）。
 *
 * 全部函数无副作用、不依赖 Vue 响应式与 Pinia —— store 的 computed/方法只是
 * 把响应式状态喂进来。独立成模块的意义：这些「页面上的数字必须是真的」的
 * 聚合口径可以脱离 store 直测（D-6 教训：提示不可信比不提示更坏）。
 */
import type { Platform } from '@/api'
import {
  HOLD_REASON_LABEL,
  JOB_STATUS_LABEL,
  SKIP_REASON_LABEL,
  type HoldReason,
  type JobStatus,
  type WelinkConversation,
  type WelinkJob,
  type WelinkMessage,
  type WelinkSettings,
} from '@/types/welink'
import type { SafetySnapshot } from '@/orchestrator/events'
import { POLL_STAGGER_MS, planPollRound, type PollRoundPlan } from '@/utils/poll'

/** 运行状态灯（§11.0） */
export type RuntimeStatus = 'idle' | 'init' | 'running' | 'backoff' | 'stopped' | 'panic'

/** 仍出现在「右栏待办」里的任务状态（终态 sent/skipped 不占位） */
export const OPEN_JOB_STATUSES: JobStatus[] = ['pending', 'discussing', 'ready', 'sending', 'failed']

/**
 * 时间线合并（messagesAppended）：按 msgUid 去重后按 sentAt/pk 升序。
 * 发送成功后管线会补一条 out 消息，可能与后续拉取到的同 uid 消息重复。
 */
export function mergeTimelinePage(existing: WelinkMessage[], fresh: WelinkMessage[]): WelinkMessage[] {
  const known = new Set(existing.map((item) => item.msgUid))
  const additions = fresh.filter((item) => !known.has(item.msgUid))
  if (!additions.length) return existing
  return [...existing, ...additions].sort((a, b) =>
    a.sentAt === b.sentAt ? a.pk - b.pk : a.sentAt < b.sentAt ? -1 : 1,
  )
}

/** 右栏待办的就地更新：剔除同 pk 旧行，开放状态追加，按 createdAt/pk 排序 */
export function upsertSortedConvJob(list: WelinkJob[], job: WelinkJob): WelinkJob[] {
  const kept = list.filter((item) => item.pk !== job.pk)
  if (OPEN_JOB_STATUSES.includes(job.status)) kept.push({ ...job })
  return kept.sort((a, b) => (a.createdAt === b.createdAt ? a.pk - b.pk : a.createdAt < b.createdAt ? -1 : 1))
}

/**
 * jobIndex 的写入 + 淘汰（统一出口，P-05）。
 *
 * ## 为什么之前是「只增不减 + 每事件全量拷贝」
 *
 * 原实现是 `index.set(pk, job); index = new Map(index)`，出现在 events/data/view
 * 共 4 处。两��问题：
 *  * **全量拷贝**：`shallowRef`靠引用变化触发下游computed 重算，所以每次写入都
 *    `new Map(...)` 拷贝整个Map（O(n)），长跑 + 高频 `jobStatusChanged`
 *    就是 O(n × events)；
 *  * **无界增长**：`listJobs` / `listJobsByStatus` / `patchJob` / `refreshReviewCount`
 *    都往里塞，**没有任何淘汰**，跑几天后 Map 里全是历史终态 job。
 *
 * ## 现在怎么做
 *
 * 写入仍走 `map.set`（Map 本身是响应式的，配合 `shallowRef` 只需**首次**建引用，
 * 后续 `set`/`delete` 不改引用也不会丢更新 —— 因为消费方 `jobOf(pk)` 是
 * 命令式读取，不依赖 computed 追踪）。
 * 淘汰按「终态 且 不在待审/ 未终态」进行：
 *
 *  **为什么能安全淘汰终态 job**：`jobIndex` 的唯一消费点是 `jobOf(pk)`
 *  （index.ts 导出，无其他消费者），而终态 job 不再出现在右栏待办里 ——
 *  拿不到 pk 就不会有人问它。真要查历史请走 `listJobs`（仓储按需查库）。
 *
 * @param map 目标索引（原地修改）
 * @param job 待写入的 job
 */
export function upsertJobIndex(index: Map<number, WelinkJob>, job: WelinkJob): void {
  index.set(job.pk, { ...job })
  if (!OPEN_JOB_STATUSES.includes(job.status) && !job.holdReason) {
    // 终态且无待审原因 → 留在库里没有消费者会问，直接淘汰
    index.delete(job.pk)
  }
}

/**
 * jobStatusChanged 的字段推导：把事件落到任务行上，返回「待审状态是否翻转」。
 * 待审原因以事件为准（O7）：转审是 ready → ready 的同状态流转，只用 from/to
 * 判断不出「刚被转人工」，必须看事件带出的 holdReason。
 */
export function applyJobStatusPatch(
  job: WelinkJob,
  to: JobStatus,
  reason: unknown,
  holdReason: string | undefined,
  now: string,
): { wasHolding: boolean; isHolding: boolean } {
  const wasHolding = job.status === 'ready' && Boolean(job.holdReason)
  job.status = to
  job.updatedAt = now
  if (to === 'skipped') job.skipReason = String(reason)
  if (holdReason !== undefined) job.holdReason = holdReason
  const isHolding = to === 'ready' && Boolean(job.holdReason)
  return { wasHolding, isHolding }
}

/** 监控中的会话（左栏数据源，按最后消息倒序） */
export function sortWatchingDesc(list: WelinkConversation[]): WelinkConversation[] {
  return list
    .filter((item) => item.watching)
    .sort((a, b) => (a.lastMsgAt === b.lastMsgAt ? b.pk - a.pk : a.lastMsgAt < b.lastMsgAt ? 1 : -1))
}

/** 未读总数（侧栏角标） */
export function unreadTotalOf(list: WelinkConversation[]): number {
  return list.reduce((sum, item) => sum + item.unreadCount, 0)
}

/** 状态灯文案（§11.0） */
export function statusTextOf(status: RuntimeStatus): string {
  switch (status) {
    case 'init':
      return '初始化中'
    case 'running':
      return '运行中'
    case 'backoff':
      return '退避中'
    case 'panic':
      return '急停'
    case 'stopped':
      return '已停止'
    default:
      return '未启动'
  }
}

/** 配额徽标文案 */
export function quotaTextOf(safety: SafetySnapshot): string {
  const closed = safety.globalClosedUntil ? ' · 全局冷却中' : ''
  return `本小时已回 ${safety.globalCount}/${safety.globalCap}${closed}`
}

/** 数据源徽标（关于页/诊断展示） */
export function sourceBadgeOf(
  settings: WelinkSettings,
  platform: Platform,
): { welink: string; agent: string; mock: boolean } {
  return {
    welink: settings.welinkSource,
    agent: settings.agent.agentSource,
    mock: settings.welinkSource === 'mock' || settings.agent.agentSource === 'mock' || platform !== 'tauri',
  }
}

/**
 * 本轮轮询节奏预估（D-6，纯函数核心）。
 *
 * 三种数据来源（按可信度递减）：
 *  1. 已跑过一轮 → 用实测错峰（最可信）；
 *  2. 装过会话清单 → 按监控数预估（`planPollRound`）；
 *  3. 都没装载（用户直接进设置页，没开过助手页）→ `known: false`，
 *     UI 不能显示「0 个会话」这种错话，只能提示「先打开助手页」或按 1 个估算。
 */
export function derivePollPlan(input: {
  intervalSec: number
  watchingCount: number
  loaded: boolean
  actualStaggerMs: number | null
}): PollRoundPlan & { known: boolean } {
  const { intervalSec, watchingCount, loaded, actualStaggerMs } = input
  const known = loaded || actualStaggerMs != null
  const plan = planPollRound({ intervalSec, conversationCount: watchingCount })
  if (!known) {
    return {
      ...plan,
      conversationCount: 0,
      staggerMs: 0,
      staggerTotalMs: 0,
      periodMs: intervalSec * 1000,
      converged: false,
      known: false,
    }
  }
  if (actualStaggerMs === null) return { ...plan, known: true }
  const staggerTotalMs = Math.max(0, plan.conversationCount - 1) * actualStaggerMs
  return {
    ...plan,
    staggerMs: actualStaggerMs,
    staggerTotalMs,
    roundMs: staggerTotalMs,
    periodMs: Math.max(0, intervalSec) * 1000 + staggerTotalMs,
    converged: plan.conversationCount > 1 && actualStaggerMs < POLL_STAGGER_MS,
    known: true,
  }
}

/** 展示标签（消费 types 层常量，UI 免于直触 infra） */
export function skipLabelOf(reason: string): string {
  return SKIP_REASON_LABEL[reason] ?? reason
}
export function holdLabelOf(reason: string): string {
  return HOLD_REASON_LABEL[reason as HoldReason] ?? reason
}
export function statusLabelOf(value: JobStatus): string {
  return JOB_STATUS_LABEL[value]
}
