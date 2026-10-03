import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ref, shallowRef } from 'vue'

import type { ConversationState, SafetySnapshot, WelinkEvent } from '@/orchestrator/events'
import { emptySummary } from '@/orchestrator/events'
import type { WelinkConversation, WelinkJob, WelinkMessage, WelinkSettings } from '@/types/welink'
import { createEventConsumer, type FuseBanner } from './events'
import type { RuntimeStatus } from './aggregate'

function job(pk: number, overrides: Partial<WelinkJob> = {}): WelinkJob {
  return {
    pk,
    targetId: 'G-1',
    status: 'pending',
    holdReason: '',
    createdAt: '2026-10-02 10:00:00',
    updatedAt: '',
    ...overrides,
  } as WelinkJob
}

function message(pk: number, msgUid: string): WelinkMessage {
  return { pk, msgUid, sentAt: '10:00', direction: 'in', atMe: false, msgType: 'text' } as WelinkMessage
}

function conversation(convId = 'G-1'): WelinkConversation {
  return { convId, unreadCount: 0, mentionCount: 0, lastMsgAt: '', lastActive: '' } as WelinkConversation
}

/** 组装一套可断言的依赖（状态 ref + 协作回调 spy） */
function makeDeps() {
  const loadConversations = vi.fn(async () => {})
  const updateRuntimeStatus = vi.fn()
  const pushLog = vi.fn()
  const deps = {
    selectedConvId: ref('G-1'),
    messages: ref<WelinkMessage[]>([]),
    conversations: ref<WelinkConversation[]>([conversation()]),
    convoStates: ref<Record<string, ConversationState>>({}),
    jobIndex: shallowRef<Map<number, WelinkJob>>(new Map()),
    convJobs: ref<WelinkJob[]>([]),
    status: ref<RuntimeStatus>('idle'),
    pullSummary: ref(emptySummary()),
    pulling: ref(false),
    safety: ref({
      panic: false,
      globalCount: 0,
      globalCap: 10,
      globalClosedUntil: null,
      convCounts: {},
      fuses: [],
      globalFuse: false,
      globalFuseReason: '',
    } as SafetySnapshot),
    fuseBanner: ref<FuseBanner | null>(null),
    settings: ref({} as WelinkSettings),
    reviewCount: ref(0),
    loadConversations,
    updateRuntimeStatus,
    pushLog,
  }
  return { deps, loadConversations, updateRuntimeStatus, pushLog }
}

describe('events 消费层', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('messagesAppended（选中会话）：时间线去重合并 + 会话行未读/最新消息打补丁', () => {
    const { deps } = makeDeps()
    const consumer = createEventConsumer(deps)
    consumer.onEvent({
      type: 'messagesAppended',
      convId: 'G-1',
      messages: [message(1, 'u1'), message(2, 'u2')],
    } as unknown as WelinkEvent)
    expect(deps.messages.value.map((item) => item.msgUid)).toEqual(['u1', 'u2'])
    expect(deps.conversations.value[0].unreadCount).toBe(2)
    expect(deps.conversations.value[0].lastActive).toBeTruthy()
  })

  it('messagesAppended（未选中会话）：只补会话行，不动时间线', () => {
    const { deps } = makeDeps()
    const consumer = createEventConsumer(deps)
    consumer.onEvent({
      type: 'messagesAppended',
      convId: 'G-other',
      messages: [message(1, 'u1')],
    } as unknown as WelinkEvent)
    expect(deps.messages.value).toHaveLength(0)
    expect(deps.conversations.value[0].unreadCount).toBe(0)
  })

  it('jobCreated：入索引；ready+holdReason 计入待审；目标会话进右栏', () => {
    const { deps } = makeDeps()
    const consumer = createEventConsumer(deps)
    consumer.onEvent({ type: 'jobCreated', job: job(1, { status: 'ready', holdReason: 'blacklist' }) } as WelinkEvent)
    expect(deps.jobIndex.value.get(1)?.status).toBe('ready')
    expect(deps.reviewCount.value).toBe(1)
    expect(deps.convJobs.value.map((item) => item.pk)).toEqual([1])
  })

  it('jobStatusChanged：待审任务被拦截 → 待审数回落并落拦截原因', () => {
    const { deps } = makeDeps()
    deps.jobIndex.value = new Map([[1, job(1, { status: 'ready', holdReason: 'blacklist' })]])
    deps.reviewCount.value = 1
    const consumer = createEventConsumer(deps)
    consumer.onEvent({ type: 'jobStatusChanged', jobPk: 1, to: 'skipped', reason: 'quiet' } as WelinkEvent)
    expect(deps.reviewCount.value).toBe(0)
    expect(deps.jobIndex.value.get(1)?.skipReason).toBe('quiet')
  })

  it('jobStatusChanged：未知 pk 静默忽略（事件晚于索引加载的常态）', () => {
    const { deps, updateRuntimeStatus } = makeDeps()
    const consumer = createEventConsumer(deps)
    consumer.onEvent({ type: 'jobStatusChanged', jobPk: 99, to: 'sent' } as WelinkEvent)
    expect(deps.reviewCount.value).toBe(0)
    expect(updateRuntimeStatus).not.toHaveBeenCalled()
  })

  it('conversationState：更新状态表并刷新状态灯', () => {
    const { deps, updateRuntimeStatus } = makeDeps()
    const consumer = createEventConsumer(deps)
    consumer.onEvent({ type: 'conversationState', convId: 'G-1', state: { state: 'backoff' } } as unknown as WelinkEvent)
    expect(deps.convoStates.value['G-1']).toEqual({ state: 'backoff' })
    expect(updateRuntimeStatus).toHaveBeenCalledTimes(1)
  })

  it('conversationsChanged：触发会话清单重载', () => {
    const { deps, loadConversations } = makeDeps()
    const consumer = createEventConsumer(deps)
    consumer.onEvent({ type: 'conversationsChanged' } as WelinkEvent)
    expect(loadConversations).toHaveBeenCalledTimes(1)
  })

  it('roundStarted：panic 态不被运行事件冲掉', () => {
    const { deps } = makeDeps()
    deps.status.value = 'panic'
    const consumer = createEventConsumer(deps)
    consumer.onEvent({ type: 'roundStarted' } as WelinkEvent)
    expect(deps.status.value).toBe('panic')
  })

  it('roundFinished：落汇总、收起 pulling、刷新状态灯', () => {
    const { deps, updateRuntimeStatus } = makeDeps()
    deps.pulling.value = true
    const consumer = createEventConsumer(deps)
    consumer.onEvent({ type: 'roundFinished', summary: { scanned: 1 } } as unknown as WelinkEvent)
    expect(deps.pullSummary.value).toEqual({ scanned: 1 })
    expect(deps.pulling.value).toBe(false)
    expect(updateRuntimeStatus).toHaveBeenCalledTimes(1)
  })

  it('fuseTripped：挂横幅 + warn 日志', () => {
    const { deps, pushLog } = makeDeps()
    const consumer = createEventConsumer(deps)
    consumer.onEvent({ type: 'fuseTripped', scope: '全局', reason: '配额', blocked: 3 } as WelinkEvent)
    expect(deps.fuseBanner.value).toEqual({ scope: '全局', reason: '配额', blocked: 3 })
    expect(pushLog).toHaveBeenCalledWith('warn', expect.stringContaining('熔断'))
  })

  it('log 事件进环形缓冲；safety/settings 事件直接替换状态', () => {
    const { deps, pushLog } = makeDeps()
    const consumer = createEventConsumer(deps)
    consumer.onEvent({ type: 'log', level: 'info', text: 'hello' } as WelinkEvent)
    expect(pushLog).toHaveBeenCalledWith('info', 'hello')
    const snap = { panic: false, globalFuse: true } as SafetySnapshot
    consumer.onEvent({ type: 'safetyChanged', snapshot: snap } as WelinkEvent)
    // ref 深响应：读回的是 snap 的代理，值相等（非同一引用）
    expect(deps.safety.value).toEqual(snap)
    const settings = { enabled: true } as WelinkSettings
    consumer.onEvent({ type: 'settingsChanged', settings } as WelinkEvent)
    expect(deps.settings.value).toEqual(settings)
  })
})
