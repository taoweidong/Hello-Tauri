/**
 * 编排层 → store 的事件流（设计 §5-P5「增量状态通知」）。
 *
 * 为什么不推全量列表：消息流可能一次追加几百条，整表推给 store 会让
 * Vue 重新 diff 整个列表（渲染风暴）。这里只推**事件**，store 增量打补丁；
 * UI 侧配合 keyed `v-for`，新增一行只挂载一行。
 *
 * 事件全部是纯数据（无函数、无类实例），因此可以直接断言、也可以落日志。
 */
import type { JobStatus, WelinkJob, WelinkMessage, WelinkSettings } from '@/types/welink'

/** 会话拉取健康度（UI 左栏的状态小点 + tooltip 的 failCount） */
export interface ConversationState {
  state: 'ok' | 'backoff'
  failCount: number
  /** 退避秒数；0 = 未退避 */
  backoffSec: number
  /** 失败原因（tooltip 展示） */
  reason: string
  /** 最后一次成功拉取的时间戳 */
  lastOkAt: string
}

/** 一轮轮询的摘要（「立即拉取」按钮的 toast 文案来源） */
export interface PollSummary {
  /** 本轮参与调度的监控会话数 */
  conversations: number
  /** 实际发起拉取的会话数（分级轮询 O2 会跳过冷会话） */
  polled: number
  /** 新增入库消息条数 */
  inserted: number
  /** 命中规则新建的回复任务数 */
  jobs: number
  /** 拉取失败的会话数 */
  failed: number
}

export function emptySummary(): PollSummary {
  return { conversations: 0, polled: 0, inserted: 0, jobs: 0, failed: 0 }
}

/** 安全闸口快照（控制条「配额徽标」「熔断横幅」的数据源） */
export interface SafetySnapshot {
  panic: boolean
  /** 全局本小时已发条数 */
  globalCount: number
  globalCap: number
  /** 全局冷却截止时刻（S3 触发后），null = 未冷却 */
  globalClosedUntil: string | null
  /** 各会话本小时已发条数（hover 明细） */
  convCounts: Record<string, number>
  /** 熔断中的场景（UI 黄条） */
  fuses: Array<{ key: string; scope: string; reason: string; since: string }>
  /** S8 兜底熔断（myUserId 为空） */
  globalFuse: boolean
  globalFuseReason: string
}

export type WelinkEvent =
  | { type: 'messagesAppended'; convId: string; messages: WelinkMessage[] }
  | { type: 'jobCreated'; job: WelinkJob }
  | {
      type: 'jobStatusChanged'
      jobPk: number
      from: JobStatus | 'unknown'
      to: JobStatus
      reason: string
      /**
       * 流转后的待审原因（O7）。
       *
       * 必须在事件里带上，不能让 store 去读自己那份旧快照 —— 转审（hold）恰恰是
       * **同一个 status（ready → ready）**，只带 `to` 的话 store 完全看不出发生了什么，
       * 「待审 N」徽标要等下一次查库才 +1（用户点了「转人工」却看不到计数变化）。
       * 传空串表示本次流转**清除**待审原因（如人工重发）。
       */
      holdReason?: string
    }
  | { type: 'jobUpdated'; job: WelinkJob }
  | { type: 'conversationState'; convId: string; state: ConversationState }
  | { type: 'conversationsChanged'; convIds: string[] }
  | { type: 'roundStarted'; round: number }
  | { type: 'roundFinished'; round: number; summary: PollSummary }
  | { type: 'safetyChanged'; snapshot: SafetySnapshot }
  | { type: 'settingsChanged'; settings: WelinkSettings }
  | { type: 'fuseTripped'; scope: string; reason: string; blocked: number }
  | { type: 'log'; level: 'info' | 'warn' | 'error'; text: string }

/** 事件接收器（store 实现；测试里换成数组收集器即可断言事件序列） */
export type EventSink = (event: WelinkEvent) => void
