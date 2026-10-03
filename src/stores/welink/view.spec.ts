import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ref, shallowRef } from 'vue'

import type { ConversationState } from '@/orchestrator/events'
import type { WelinkRuntime } from '@/orchestrator/runtime'
import type { WelinkRepository } from '@/infra/db'
import type { WelinkConversation, WelinkJob, WelinkMessage } from '@/types/welink'
import { createConversationView, type ConversationViewDeps } from './view'

function conversation(convId: string, watching = true): WelinkConversation {
  return {
    pk: 1,
    convId,
    title: convId,
    watching,
    autoReply: true,
    muteUntil: null,
    unreadCount: 2,
    mentionCount: 0,
    lastMsgAt: '10:00',
    lastActive: '',
    lastCursor: '',
    updatedAt: '',
  } as WelinkConversation
}

function message(sentAt: string): WelinkMessage {
  return { pk: 1, msgUid: sentAt, sentAt } as WelinkMessage
}

function job(pk: number, targetId: string): WelinkJob {
  return { pk, targetId, status: 'ready', holdReason: '', createdAt: '' } as WelinkJob
}

interface Harness {
  deps: ConversationViewDeps
  repo: WelinkRepository
  runtime: WelinkRuntime
  runtimeRepo: { upsertConversation: ReturnType<typeof vi.fn> }
  pushLog: ReturnType<typeof vi.fn>
  refreshSafety: ReturnType<typeof vi.fn>
  conversations: ReturnType<typeof ref<WelinkConversation[]>>
}

function makeHarness(): Harness {
  const repo = {
    listConversations: vi.fn(async () => [conversation('G-1')]),
    countConversations: vi.fn(async () => 1),
    getConversation: vi.fn(async () => null),
    countMessages: vi.fn(async () => 0),
    markRead: vi.fn(async () => undefined),
    listMessages: vi.fn(async () => [message('10:00')]),
    listJobs: vi.fn(async () => []),
    listJobsByStatus: vi.fn(async () => [job(1, 'G-1'), job(2, 'G-other')]),
    countHolding: vi.fn(async () => 0),
    upsertConversation: vi.fn(async () => undefined),
    updateConversation: vi.fn(async () => undefined),
    setAutoReply: vi.fn(async () => 1),
    removeConversation: vi.fn(async () => undefined),
  } as unknown as WelinkRepository
  const runtimeRepo = { upsertConversation: vi.fn(async () => undefined) }
  const runtime = {
    port: vi.fn(() => ({ listConversations: async () => [] as unknown[] })),
    repo: runtimeRepo,
    poller: {
      conversationState: vi.fn(
        (): ConversationState => ({ state: 'ok', failCount: 0, backoffSec: 0, reason: '', lastOkAt: '' }),
      ),
      refreshConversations: vi.fn(),
    },
    gate: {
      cacheConversation: vi.fn(),
      invalidateConversation: vi.fn(),
    },
  } as unknown as WelinkRuntime
  const conversations = ref<WelinkConversation[]>([])
  const pushLog = vi.fn()
  const refreshSafety = vi.fn(async () => {})
  const deps: ConversationViewDeps = {
    conversations,
    conversationsLoaded: ref(false),
    convoStates: ref<Record<string, ConversationState>>({}),
    messages: ref<WelinkMessage[]>([]),
    convJobs: ref<WelinkJob[]>([]),
    jobIndex: shallowRef<Map<number, WelinkJob>>(new Map()),
    hasMoreMessages: ref(false),
    selectedConvId: ref(''),
    reviewCount: ref(0),
    runtimeHolder: { current: runtime },
    repo: () => repo,
    ensureRuntime: async () => runtime,
    pushLog,
    refreshSafety,
  }
  return { deps, repo, runtime, runtimeRepo, pushLog, refreshSafety, conversations }
}

describe('view：装载与 Gate 缓存回填', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('loadConversations：落清单、标记已装载、逐会话回填 Gate 缓存（O5）', async () => {
    const harness = makeHarness()
    const view = createConversationView(harness.deps)
    await view.loadConversations()
    expect(harness.deps.conversationsLoaded.value).toBe(true)
    expect(harness.deps.conversations.value).toHaveLength(1)
    expect(harness.runtime.gate.cacheConversation).toHaveBeenCalledWith('G-1', true, null)
    expect(harness.deps.convoStates.value['G-1']).toEqual({ state: 'ok', failCount: 0, backoffSec: 0, reason: '', lastOkAt: '' })
  })

  it('列表超限且总数更大：明确告警而不是静默截断（D-5）', async () => {
    const harness = makeHarness()
    const full = Array.from({ length: 500 }, (_, index) => conversation(`G-${index}`))
    ;(harness.repo.listConversations as ReturnType<typeof vi.fn>).mockResolvedValue(full)
    ;(harness.repo.countConversations as ReturnType<typeof vi.fn>).mockResolvedValue(501)
    const loggerWarn = vi.spyOn(await import('@/utils/logger').then((m) => m.logger), 'warn')
    const view = createConversationView(harness.deps)
    await view.loadConversations()
    expect(loggerWarn).toHaveBeenCalledWith(expect.stringContaining('已达上限'))
  })

  it('refreshReviewCount：待审计数 + 索引回填', async () => {
    const harness = makeHarness()
    ;(harness.repo.countHolding as ReturnType<typeof vi.fn>).mockResolvedValue(2)
    ;(harness.repo.listJobs as ReturnType<typeof vi.fn>).mockResolvedValue([job(7, 'G-1')])
    const view = createConversationView(harness.deps)
    await view.refreshReviewCount()
    expect(harness.deps.reviewCount.value).toBe(2)
    expect(harness.deps.jobIndex.value.get(7)).toBeTruthy()
  })
})

describe('view：时间线与竞态守卫（F-4）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('selectConversation：markRead → 清未读 → 拉时间线 → 过滤本会话待办', async () => {
    const harness = makeHarness()
    harness.deps.conversations.value = [conversation('G-1')]
    const view = createConversationView(harness.deps)
    await view.selectConversation('G-1')
    expect(harness.repo.markRead).toHaveBeenCalled()
    expect(harness.deps.conversations.value[0].unreadCount).toBe(0)
    expect(harness.deps.messages.value).toHaveLength(1)
    expect(harness.deps.convJobs.value.map((item) => item.pk)).toEqual([1])
    expect(harness.deps.hasMoreMessages.value).toBe(false)
  })

  it('选中不存在的会话：不查库不炸', async () => {
    const harness = makeHarness()
    const view = createConversationView(harness.deps)
    await expect(view.selectConversation('nope')).resolves.toBeUndefined()
    expect(harness.repo.markRead).not.toHaveBeenCalled()
  })

  it('loadEarlierMessages：旧页前插；空页收起 hasMore', async () => {
    const harness = makeHarness()
    harness.deps.selectedConvId.value = 'G-1'
    harness.deps.conversations.value = [conversation('G-1')]
    harness.deps.messages.value = [message('11:00')]
    const view = createConversationView(harness.deps)
    ;(harness.repo.listMessages as ReturnType<typeof vi.fn>).mockResolvedValue([message('10:30'), message('10:00')])
    await view.loadEarlierMessages(2)
    expect(harness.deps.messages.value.map((item) => item.msgUid)).toEqual(['10:30', '10:00', '11:00'])
    // 2 条旧页 = 返回数达到 limit → 可能还有更多
    expect(harness.deps.hasMoreMessages.value).toBe(true)

    ;(harness.repo.listMessages as ReturnType<typeof vi.fn>).mockResolvedValue([])
    await view.loadEarlierMessages(2)
    expect(harness.deps.hasMoreMessages.value).toBe(false)
  })

  it('loadEarlierMessages 的 in-flight 锁：连点只发一次请求（F-4）', async () => {
    const harness = makeHarness()
    harness.deps.selectedConvId.value = 'G-1'
    harness.deps.conversations.value = [conversation('G-1')]
    harness.deps.messages.value = [message('11:00')]
    // 用对象持有（而非 let 变量）：TS 控制流会把闭包内赋值的 let 收窄成 null
    const releaseRef: { current: (() => void) | null } = { current: null }
    ;(harness.repo.listMessages as ReturnType<typeof vi.fn>).mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseRef.current = () => resolve([message('10:00')])
        }),
    )
    const view = createConversationView(harness.deps)
    const first = view.loadEarlierMessages()
    const second = view.loadEarlierMessages()
    releaseRef.current?.()
    await Promise.all([first, second])
    expect(harness.repo.listMessages).toHaveBeenCalledTimes(1)
  })
})

describe('view：会话配置联动', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('updateConversation：关监控联动关自动回复（§11.5）+ Gate 失效 + 刷新安全快照', async () => {
    const harness = makeHarness()
    harness.deps.conversations.value = [conversation('G-1')]
    const view = createConversationView(harness.deps)
    await view.updateConversation('G-1', { watching: false })
    const calls = (harness.repo.updateConversation as ReturnType<typeof vi.fn>).mock.calls
    expect(calls[0]).toEqual(['G-1', { watching: false }])
    expect(calls[1]).toEqual(['G-1', { autoReply: false }])
    expect(harness.runtime.gate.invalidateConversation).toHaveBeenCalledWith('G-1')
    expect(harness.refreshSafety).toHaveBeenCalledTimes(1)
  })

  it('muteConversation：写 muteUntil + Gate 失效 + 日志', async () => {
    const harness = makeHarness()
    const view = createConversationView(harness.deps)
    await view.muteConversation('G-1', 1)
    const patch = (harness.repo.updateConversation as ReturnType<typeof vi.fn>).mock.calls[0][1]
    expect(patch.muteUntil).toBeTruthy()
    expect(harness.runtime.gate.invalidateConversation).toHaveBeenCalledWith('G-1')
    expect(harness.pushLog).toHaveBeenCalledWith('info', expect.stringContaining('静音'))
  })

  it('removeConversation：删除选中的会话时清空时间线与右栏', async () => {
    const harness = makeHarness()
    harness.deps.selectedConvId.value = 'G-1'
    harness.deps.messages.value = [message('10:00')]
    const view = createConversationView(harness.deps)
    await view.removeConversation('G-1')
    expect(harness.deps.selectedConvId.value).toBe('')
    expect(harness.deps.messages.value).toHaveLength(0)
    expect(harness.runtime.poller.refreshConversations).toHaveBeenCalledTimes(1)
  })

  it('syncConversations：候选导入默认不监控、勾选只省点击（§11.5 底线）', async () => {
    const harness = makeHarness()
    ;(harness.runtime.port as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      listConversations: async () => [
        { convType: 'group', convId: 'new-1', title: '新群' },
        { convType: 'group', convId: 'G-1', title: '已有' },
      ],
    })
    harness.deps.conversations.value = [conversation('G-1')]
    const view = createConversationView(harness.deps)
    const result = await view.syncConversations(['new-1'])
    expect(result.imported).toBe(1)
    expect(result.watched).toBe(1)
    // 导入走的是 runtime.repo（编排层运行时持有的仓储），不是视图的网关读取
    const upsert = harness.runtimeRepo.upsertConversation.mock.calls[0][0]
    expect(upsert).toEqual({ convType: 'group', convId: 'new-1', title: '新群', watching: true })
    expect(upsert.autoReply).toBeUndefined()
  })
})
