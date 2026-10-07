/**
 * 事件消费层（P5）—— WelinkEvent → store 状态的增量补丁（quality-hardening-2026-10 D1）。
 *
 * 职责边界：只做「事件 → 就地改一行」的状态同步，不做聚合（aggregate.ts）、
 * 不发起查询以外的事件副作用。重活（去重/排序/待审翻转判定）委托 aggregate
 * 纯函数，本模块负责把响应式容器接上去。
 */
import type { Ref, ShallowRef } from 'vue'

import { nowStamp } from '@/utils/time'
import type { ConversationState, PollSummary, SafetySnapshot, WelinkEvent } from '@/orchestrator/events'
import type { WelinkConversation, WelinkJob, WelinkMessage, WelinkSettings } from '@/types/welink'
import {
  applyJobStatusPatch,
  mergeTimelinePage,
  OPEN_JOB_STATUSES,
  upsertJobIndex,
  upsertSortedConvJob,
  type RuntimeStatus,
} from './aggregate'

/** 熔断横幅（S8 触发时的黄条） */
export interface FuseBanner {
  scope: string
  reason: string
  blocked: number
}

export interface EventConsumerDeps {
  selectedConvId: Ref<string>
  messages: Ref<WelinkMessage[]>
  conversations: Ref<WelinkConversation[]>
  convoStates: Ref<Record<string, ConversationState>>
  jobIndex: ShallowRef<Map<number, WelinkJob>>
  convJobs: Ref<WelinkJob[]>
  status: Ref<RuntimeStatus>
  pullSummary: Ref<PollSummary>
  pulling: Ref<boolean>
  safety: Ref<SafetySnapshot>
  fuseBanner: Ref<FuseBanner | null>
  settings: Ref<WelinkSettings>
  reviewCount: Ref<number>
  /** 跨模块协作（index 装配后注入）：conversationsChanged 触发重载 */
  loadConversations: () => Promise<void>
  updateRuntimeStatus: () => void
  pushLog: (level: 'info' | 'warn' | 'error', text: string) => void
}

export interface WelinkEventConsumer {
  onEvent(event: WelinkEvent): void
}

export function createEventConsumer(deps: EventConsumerDeps): WelinkEventConsumer {
  const {
    selectedConvId,
    messages,
    conversations,
    convoStates,
    jobIndex,
    convJobs,
    status,
    pullSummary,
    pulling,
    safety,
    fuseBanner,
    settings,
    reviewCount,
    loadConversations,
    updateRuntimeStatus,
    pushLog,
  } = deps

  /** 把新消息的汇总影响就地打到会话行上（O3 的冗余列在内存侧的镜像） */
  function patchConversationFromMessages(convId: string, rows: WelinkMessage[]) {
    if (!rows.length) return
    const conv = conversations.value.find((item) => item.convId === convId)
    if (!conv) return
    const incoming = rows.filter((item) => item.direction === 'in')
    conv.unreadCount += incoming.length
    conv.mentionCount += incoming.filter((item) => item.atMe && item.msgType === 'text').length
    const latest = rows.reduce((acc, item) => (item.sentAt > acc ? item.sentAt : acc), conv.lastMsgAt)
    conv.lastMsgAt = latest
    conv.lastActive = nowStamp()
    conversations.value = [...conversations.value]
  }

  /** 任务：更新索引 + 选中会话的待办列表 */
  function patchJob(job: WelinkJob) {
    upsertJobIndex(jobIndex.value, job)
    if (job.targetId === selectedConvId.value) convJobs.value = upsertSortedConvJob(convJobs.value, job)
  }

  function onEvent(event: WelinkEvent) {
    switch (event.type) {
      case 'messagesAppended': {
        if (event.convId === selectedConvId.value) {
          messages.value = mergeTimelinePage(messages.value, event.messages)
        }
        patchConversationFromMessages(event.convId, event.messages)
        break
      }
      case 'jobCreated': {
        patchJob(event.job)
        if (event.job.status === 'ready' && event.job.holdReason) reviewCount.value += 1
        if (event.job.targetId === selectedConvId.value) convJobs.value = upsertSortedConvJob(convJobs.value, event.job)
        break
      }
      case 'jobStatusChanged': {
        const job = jobIndex.value.get(event.jobPk)
        if (job) {
          const { wasHolding, isHolding } = applyJobStatusPatch(
            job,
            event.to,
            event.reason,
            event.holdReason,
            nowStamp(),
          )
          if (!wasHolding && isHolding) reviewCount.value += 1
          if (wasHolding && !isHolding) reviewCount.value = Math.max(0, reviewCount.value - 1)
          // `applyJobStatusPatch` 已**原地**改了 job 的 status/updatedAt/holdReason，
          // 这里不再 `new Map(jobIndex.value)` 触发 O(n) 拷贝（P-05）。
          // jobIndex 的消费点是命令式 `jobOf(pk)`，不依赖引用变化触发重算。
          // 终态且无待审原因 → 从索引淘汰（无人会再按 pk 问它）
          if (!OPEN_JOB_STATUSES.includes(job.status) && !job.holdReason) jobIndex.value.delete(job.pk)
          if (job.targetId === selectedConvId.value) convJobs.value = upsertSortedConvJob(convJobs.value, job)
        }
        break
      }
      case 'jobUpdated': {
        patchJob(event.job)
        break
      }
      case 'conversationState': {
        convoStates.value = { ...convoStates.value, [event.convId]: event.state }
        updateRuntimeStatus()
        break
      }
      case 'conversationsChanged': {
        void loadConversations()
        break
      }
      case 'roundStarted': {
        if (status.value !== 'panic') status.value = 'running'
        break
      }
      case 'roundFinished': {
        pullSummary.value = event.summary
        pulling.value = false
        updateRuntimeStatus()
        break
      }
      case 'safetyChanged': {
        safety.value = event.snapshot
        break
      }
      case 'fuseTripped': {
        fuseBanner.value = { scope: event.scope, reason: event.reason, blocked: event.blocked }
        pushLog('warn', `${event.scope} 触发熔断（${event.reason}），本窗已拦 ${event.blocked} 条`)
        break
      }
      case 'settingsChanged': {
        settings.value = event.settings
        break
      }
      case 'log': {
        pushLog(event.level, event.text)
        break
      }
    }
  }

  return { onEvent }
}
