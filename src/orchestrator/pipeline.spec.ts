import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Pipeline 单测（设计 §13「生成段并发 2 / 外发段串行 1 的不变量、状态机全路径、
 * 崩溃恢复、双发防护」）。
 *
 * 这一层是**状态机 + 并发语义**的集中地，所以测试策略与别处不同：
 *
 *  1. 仓储用**有状态的假实现**（不是纯 vi.fn 记录器）。管线的正确性建立在
 *     「库里现在是什么状态」之上 —— `commitDraft` 只接受 `discussing`、
 *     `markSent` 只接受 `sending`，用返回固定值的桩根本测不出这些约束。
 *     假实现逐条复刻 `repos/welink.ts` 的 WHERE 条件，同时在 `vi.fn` 上留痕，
 *     于是「状态对不对」和「参数传得对不对」都能断言。
 *  2. 时间走注入的假时钟（`TimerApi` + `now`），并发用 deferred 精确控制
 *     —— 「最多 2 个并发生成」「外发绝不并行」这类断言必须能卡在中间观察。
 *  3. Gate 用桩：`safety-gate.spec.ts` 已经把 S1–S8 的判定穷尽了，
 *     这里只需要「四种决策管线分别怎么做」。
 */

import { createPipeline, GENERATE_CONCURRENCY, MAX_ATTEMPTS, MAX_SEND_ATTEMPTS } from '@/orchestrator/pipeline'
import type { Pipeline } from '@/orchestrator/pipeline'
import type { GateDecision, SafetyGate } from '@/orchestrator/safety-gate'
import type { SafetySnapshot, WelinkEvent } from '@/orchestrator/events'
import type { TimerApi } from '@/orchestrator/timers'
import type { WelinkRepository } from '@/infra/db/ports'
import type { AgentCallRecord, AgentClient } from '@/infra/agent'
import type { WelinkPort } from '@/infra/welink'
import {
  DEFAULT_WELINK_SETTINGS,
  type NormalizedMessage,
  type WelinkAgentLog,
  type WelinkConversation,
  type WelinkJob,
  type WelinkMessage,
  type WelinkSettings,
  type WelinkSkill,
} from '@/types/welink'
import type { SkillAttribution } from '@/infra/db/ports'
import type { RagClient, RagChunk, RagQuery } from '@/infra/rag'
import { createMockKnowledgePort, resetMockKnowledge, seedMockKnowledgeFile, type KnowledgePort } from '@/infra/knowledge'

// ---------------------------------------------------------------- 手动驱动的假时钟

/** 只入队的调度器：`advance` 推进虚拟时间并触发到期回调（同 poller.spec.ts） */
function createScheduler() {
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
    nextAt(): number | null {
      const times = [...pending.values()].map((item) => item.at)
      return times.length ? Math.min(...times) : null
    },
    now() {
      return current
    },
    advance(ms: number) {
      current += ms
      for (const [id, item] of [...pending.entries()]) {
        if (item.at <= current) {
          pending.delete(id)
          item.handler()
        }
      }
    },
  }
}

async function settle(rounds = 60) {
  for (let index = 0; index < rounds; index += 1) await Promise.resolve()
}

/**
 * 把管线跑到「静止」：反复触发到期的 **0ms** 定时器并排干微任务。
 *
 * 必须用它而不是裸 `settle()`：`start()`/`enqueue()` 都只调 `scheduleFlush(0)`，
 * 而 0ms 回调排在注入的假调度器里 —— 不推一下永远不会执行。`advance(0)` 只触发
 * 「当下就该跑」的定时器，1500ms / 30000ms 这类重试排程仍留在队列中可被断言。
 */
async function pump(h: Harness, rounds = 6) {
  for (let index = 0; index < rounds; index += 1) {
    h.scheduler.advance(0)
    await settle()
  }
}

// ---------------------------------------------------------------- 夹具

function job(overrides: Partial<WelinkJob> = {}): WelinkJob {
  return {
    pk: 1,
    triggerMsgPk: 10,
    triggerType: 'group_at_me',
    targetType: 'group',
    targetId: 'G-1001',
    sendModeUsed: 'auto',
    contextSnapshot: '',
    draft: '',
    status: 'pending',
    attempts: 0,
    lastError: '',
    skipReason: '',
    holdReason: '',
    skillId: '',
    skillName: '',
    skillSource: '',
    rating: null,
    createdAt: '2026-09-27 14:00:00',
    updatedAt: '2026-09-27 14:00:00',
    finishedAt: null,
    triggerSummary: '@你 看下接口',
    targetTitle: '研发一组',
    ...overrides,
  }
}

function conversation(overrides: Partial<WelinkConversation> = {}): WelinkConversation {
  return {
    pk: 1,
    convType: 'group',
    convId: 'G-1001',
    title: '研发一组',
    remark: '',
    watching: true,
    autoReply: true,
    muteUntil: null,
    lastMsgAt: '',
    unreadCount: 0,
    mentionCount: 0,
    lastActive: '',
    lastCursor: '',
    updatedAt: '',
    ...overrides,
  }
}

function contextMessage(overrides: Partial<WelinkMessage> = {}): WelinkMessage {
  const base: NormalizedMessage = {
    msgUid: 'm-10',
    convType: 'group',
    convId: 'G-1001',
    direction: 'in',
    senderId: 'E-9001',
    senderName: '赵敏',
    content: '@你 看下接口报 500 的问题',
    msgType: 'text',
    atMe: true,
    sentAt: '2026-09-27 13:59:00',
  }
  return { ...base, pk: 10, convPk: 1, readFlag: false, ...overrides }
}

const emptySnapshot = (): SafetySnapshot => ({
  panic: false,
  globalCount: 0,
  globalCap: 30,
  globalClosedUntil: null,
  convCounts: {},
  fuses: [],
  globalFuse: false,
  globalFuseReason: '',
})

/** 有状态假仓储：逐条复刻真实实现的关键 WHERE 条件 */
function createFakeRepo(
  seed: { jobs?: WelinkJob[]; conversations?: WelinkConversation[]; context?: WelinkMessage[] } = {},
) {
  const jobs = new Map<number, WelinkJob>()
  for (const item of seed.jobs ?? []) jobs.set(item.pk, { ...item })
  const conversations = new Map<string, WelinkConversation>()
  for (const item of seed.conversations ?? [conversations0()]) conversations.set(item.convId, { ...item })
  /** 「该 job 的 out 消息已落库」—— markSent 成功即置位，用于模拟「发出去了但没记上」 */
  const receipts = new Set<number>()
  /** markSent 传入的回执（断言 msgUid/content/convPk 用） */
  const sentReceipts = new Map<number, { msgUid: string; sentAt: string; convPk: number; content: string }>()
  const agentLogs: Array<Record<string, unknown>> = []

  function edit(pk: number, mutate: (item: WelinkJob) => void): boolean {
    const item = jobs.get(pk)
    if (!item) return false
    mutate(item)
    return true
  }

  const mocks = {
    getJob: vi.fn(async (pk: number) => {
      const item = jobs.get(pk)
      return item ? { ...item } : null
    }),
    getConversation: vi.fn(async (convId: string) => {
      const item = conversations.get(convId)
      return item ? { ...item } : null
    }),
    /**
     * 触发消息按主键取（S5 修复合入后，管线的外发段用它拿 senderId 传给 Gate）。
     * 用 seed.context 建索引；jobs 里引用到但不在 context 里的 pk 补一条同形消息，
     * 保证任何 job 都能拿到 senderId，不会因取不到而退化成空串。
     */
    getMessage: vi.fn(async (pk: number) => {
      const indexed = new Map<number, WelinkMessage>()
      for (const item of seed.context ?? [contextMessage()]) indexed.set(item.pk, item)
      for (const job of jobs.values()) {
        if (!indexed.has(job.triggerMsgPk)) indexed.set(job.triggerMsgPk, contextMessage({ pk: job.triggerMsgPk }))
      }
      const found = indexed.get(pk)
      return found ? { ...found } : null
    }),
    recentContext: vi.fn(async (_convPk: number, maxN: number) => (seed.context ?? [contextMessage()]).slice(-maxN)),
    /** 乐观锁：`expect` 不匹配则不动（对应真实实现的 AND status = ?n） */
    markStatus: vi.fn(async (pk: number, status: WelinkJob['status'], expect?: WelinkJob['status']) => {
      const item = jobs.get(pk)
      if (!item) return false
      if (expect && item.status !== expect) return false
      item.status = status
      return true
    }),
    /** 要点3：draft 与 ready 同一条 UPDATE，且只在 discussing 时可写；skill-routing 三列同条 */
    commitDraft: vi.fn(async (pk: number, draft: string, contextSnapshot?: string, skill?: SkillAttribution) => {
      const item = jobs.get(pk)
      if (!item || item.status !== 'discussing') return false
      item.draft = draft
      item.status = 'ready'
      item.holdReason = ''
      if (contextSnapshot !== undefined) item.contextSnapshot = contextSnapshot
      if (skill) {
        item.skillId = skill.id
        item.skillName = skill.name
        item.skillSource = skill.source
      }
      return true
    }),
    recordAttemptFailure: vi.fn(async (pk: number, status: WelinkJob['status'], error: string) => {
      edit(pk, (item) => {
        item.attempts += 1
        item.lastError = error
        item.status = status
      })
    }),
    requeueJob: vi.fn(async (pk: number) => {
      const item = jobs.get(pk)
      if (!item || !['failed', 'skipped', 'ready'].includes(item.status)) return false
      item.status = 'ready'
      item.skipReason = ''
      item.holdReason = ''
      item.lastError = ''
      item.finishedAt = null
      return true
    }),
    skipJob: vi.fn(async (pk: number, reason: string) => {
      edit(pk, (item) => {
        item.status = 'skipped'
        item.skipReason = reason
      })
    }),
    holdJob: vi.fn(async (pk: number, reason: string) => {
      edit(pk, (item) => {
        item.status = 'ready'
        item.holdReason = reason
      })
    }),
    suspendJob: vi.fn(async (pk: number) => {
      edit(pk, (item) => {
        item.status = 'ready'
        item.holdReason = ''
      })
    }),
    /** 只接受 sending（防双发记账），成功后置回执位 */
    markSent: vi.fn(
      async (pk: number, receipt: { msgUid: string; sentAt: string; convPk: number; content: string }) => {
        const item = jobs.get(pk)
        if (!item || item.status !== 'sending') return false
        item.status = 'sent'
        item.lastError = ''
        receipts.add(pk)
        sentReceipts.set(pk, receipt)
        return true
      },
    ),
    hasOutgoingReceipt: vi.fn(async (pk: number) => receipts.has(pk)),
    insertAgentLog: vi.fn(async (log: Record<string, unknown>) => {
      agentLogs.push(log)
      return { pk: agentLogs.length, seq: agentLogs.length, createdAt: '', ...log } as unknown as WelinkAgentLog
    }),
  }

  const repo = mocks as unknown as WelinkRepository
  return { repo, mocks, jobs, receipts, sentReceipts, agentLogs, conversations }
}

function conversations0(): WelinkConversation {
  return conversation()
}

/**
 * 默认外发端口：**立即返回成功**。
 *
 * 为什么默认不能「挂起等手动放行」：`port.send` 一旦挂起，`flush()` 就被卡在
 * `await sendOne()` 里 —— 于是 `drain()` 永远回不来（表现为 5s 超时），而且
 * 「生成完成 → 入外发队列」的链式冲刷也走不下去。需要观察「外发严格串行」的
 * 用例显式传 `manualSend: true`，它会挂起但可通过 `port.releaseAll()` 放行。
 */
const okSend = async (text: string) => ({ msgUid: `uid-${text}` })

interface Harness {
  pipeline: Pipeline
  scheduler: ReturnType<typeof createScheduler>
  events: WelinkEvent[]
  repo: ReturnType<typeof createFakeRepo>
  gate: {
    check: ReturnType<typeof vi.fn>
    onSent: ReturnType<typeof vi.fn>
    snapshot: ReturnType<typeof vi.fn>
  }
  agent: {
    client: AgentClient
    complete: ReturnType<typeof vi.fn>
    /** 主动触发一次录音回调（测 prompt 归属） */
    emitCall: (record: Partial<AgentCallRecord>) => void
    readonly active: number
    readonly maxActive: number
    readonly calls: string[]
    /** 放行所有被 defer 卡住的 complete */
    releaseAll: () => void
    /** 之后所有 complete 都自动立即返回（不用手动放行） */
    autoResolve: () => void
  }
  port: { send: ReturnType<typeof vi.fn>; releaseAll: () => void; sendCalls: string[]; readonly maxActive: number }
  statusEvents: () => Array<{ jobPk: number; from: string; to: string; reason: string }>
}

function harness(
  config: {
    jobs?: WelinkJob[]
    conversations?: WelinkConversation[]
    context?: WelinkMessage[]
    settings?: Partial<WelinkSettings>
    decision?: GateDecision | (() => GateDecision)
    reply?: string | ((prompt: string) => string)
    /** complete 是否自动返回；false 时需手动 releaseAll（观察并发用） */
    autoComplete?: boolean
    /** 是否自动返回默认真值与自动完成 */
    sendImpl?: (text: string) => Promise<{ msgUid: string }>
    /** 外发端口是否挂起等 `port.releaseAll()`（测「严格串行」用） */
    manualSend?: boolean
    /** RAG 检索假件（rag-retrieval；不传 = 不装配检索，行为与升级前一致） */
    rag?: () => RagClient
    /** 本地知识文档端口（knowledge-sedimentation；不传 = 不装配文档注入） */
    knowledge?: () => KnowledgePort
    now?: string
  } = {},
): Harness {
  const scheduler = createScheduler()
  const events: WelinkEvent[] = []
  const repo = createFakeRepo({ jobs: config.jobs, conversations: config.conversations, context: config.context })

  const settings: WelinkSettings = {
    ...DEFAULT_WELINK_SETTINGS,
    enabled: true,
    myUserId: 'E-0001',
    sendMode: 'auto',
    ...config.settings,
  }

  const checkMock = vi.fn((): GateDecision =>
    typeof config.decision === 'function'
      ? config.decision()
      : (config.decision ?? { action: 'send', reason: '', detail: '放行' }),
  )
  const onSentMock = vi.fn()
  const snapshotMock = vi.fn(emptySnapshot)
  const gate = {
    check: checkMock,
    onSent: onSentMock,
    snapshot: snapshotMock,
    // 以下是管线不调用、但接口要求的方法（桩成 noop，保证类型完整）
    setPanic: vi.fn(),
    setEnabled: vi.fn(),
    reload: vi.fn(),
    settings: () => settings,
    fused: vi.fn(() => false),
    resetFuse: vi.fn(),
    invalidateConversation: vi.fn(),
    primeConversation: vi.fn(),
    primeGlobal: vi.fn(),
    onFuse: vi.fn(),
  } as unknown as SafetyGate

  // —— Agent：可卡住（并发观察）、可失败、带录音回调 ——
  let callHandler: ((record: AgentCallRecord) => void) | null = null
  let active = 0
  let maxActive = 0
  const calls: string[] = []
  const parks: Array<{ resolve: () => void; reject: (error: unknown) => void; prompt: string }> = []
  let auto = config.autoComplete ?? true
  const replyOf = (prompt: string) =>
    typeof config.reply === 'function' ? config.reply(prompt) : (config.reply ?? '收到，我看一下，稍后回复你。')

  const complete = vi.fn(async (prompt: string) => {
    calls.push(prompt)
    active += 1
    maxActive = Math.max(maxActive, active)
    if (!auto) await new Promise<void>((resolve, reject) => parks.push({ resolve, reject, prompt }))
    active -= 1
    const reply = replyOf(prompt)
    // 真实 mock 与 http 客户端都在 complete 完成后回调 onCall（成功与失败都回调）
    callHandler?.({ prompt, response: reply, status: 'ok', latencyMs: 1, error: '' })
    return reply
  })

  const agent = {
    complete,
    onCall(handler: (record: AgentCallRecord) => void) {
      callHandler = handler
    },
  } as AgentClient

  // —— 外发端口：可卡住（串行观察） ——
  const sendCalls: string[] = []
  let sendActive = 0
  let sendMaxActive = 0
  const sendParks: Array<{ resolve: () => void }> = []
  const send = vi.fn(async (_target: unknown, text: string) => {
    sendCalls.push(text)
    sendActive += 1
    sendMaxActive = Math.max(sendMaxActive, sendActive)
    if (config.manualSend) await new Promise<void>((resolve) => sendParks.push({ resolve }))
    sendActive -= 1
    if (config.sendImpl) return config.sendImpl(text)
    return okSend(text)
  })
  const port = { send, listConversations: vi.fn(), pull: vi.fn() } as unknown as WelinkPort

  // 固定「现在」（不推进）：时间推进由 scheduler.advance 单独完成 ——
  // 两者都动会让「定时器到点」与「业务判定时间」混淆，断言变难写。
  const clockMs = new Date(config.now ?? '2026-09-27T14:00:00').getTime()
  const pipeline = createPipeline({
    repo: repo.repo,
    gate,
    agent,
    rag: config.rag,
    knowledge: config.knowledge,
    port: () => port,
    settings: () => settings,
    emit: (event) => events.push(event),
    timers: scheduler.timers,
    now: () => new Date(clockMs),
    retryDelayMs: 30_000,
  })

  return {
    pipeline,
    scheduler,
    events,
    repo,
    gate: { check: checkMock, onSent: onSentMock, snapshot: snapshotMock },
    agent: {
      client: agent,
      complete,
      emitCall: (record) =>
        callHandler?.({
          prompt: '',
          response: '',
          status: 'ok',
          latencyMs: 1,
          error: '',
          ...record,
        } as AgentCallRecord),
      get active() {
        return active
      },
      get maxActive() {
        return maxActive
      },
      calls,
      releaseAll() {
        auto = true
        for (const park of parks.splice(0)) park.resolve()
      },
      autoResolve() {
        auto = true
      },
    },
    port: {
      send,
      releaseAll() {
        for (const park of sendParks.splice(0)) park.resolve()
      },
      sendCalls,
      get maxActive() {
        return sendMaxActive
      },
    },
    statusEvents: () =>
      events
        .filter((event) => event.type === 'jobStatusChanged')
        .map((event) => event as { jobPk: number; from: string; to: string; reason: string }),
  }
}

const jobOf = (h: Harness, pk: number): WelinkJob => h.repo.jobs.get(pk)!

// ---------------------------------------------------------------- 生成段：正常路径

describe('orchestrator/pipeline —— 生成段正常路径', () => {
  it('pending → discussing → ready 全链落库，并把 job 交给外发队列', async () => {
    const h = harness({ jobs: [job()], sendImpl: async () => ({ msgUid: 'u1' }) })
    h.pipeline.start()
    h.pipeline.enqueue(1)
    await h.pipeline.drain()

    // markStatus 带 expect='pending'（乐观锁，避免抢别人的活）
    expect(h.repo.mocks.markStatus).toHaveBeenCalledWith(1, 'discussing', 'pending')
    // 要点3：draft 与 ready 同一条 UPDATE，且带上了提示词快照
    const commit = h.repo.mocks.commitDraft.mock.calls[0]
    expect(commit[0]).toBe(1)
    expect(commit[1]).toBe('收到，我看一下，稍后回复你。')
    expect(commit[2]).toContain('【最近对话】')
    expect(h.repo.mocks.recentContext).toHaveBeenCalledWith(1, settingsMaxContext())
  })

  it('提示词由 renderPrompt 渲染：目标/对方/上下文/问题四处都填上', async () => {
    const h = harness({ jobs: [job()], sendImpl: async () => ({ msgUid: 'u1' }) })
    h.pipeline.start()
    h.pipeline.enqueue(1)
    await h.pipeline.drain()

    const prompt = h.agent.calls[0]
    expect(prompt).toContain('【目标会话】研发一组')
    expect(prompt).toContain('【对方】赵敏')
    expect(prompt).toContain('【需要回复的消息】\n@你 看下接口报 500 的问题')
  })

  it('状态事件按 §7.3 依次发出（discussing → ready → sending → sent）', async () => {
    const h = harness({ jobs: [job()], sendImpl: async () => ({ msgUid: 'u1' }) })
    h.pipeline.start()
    h.pipeline.enqueue(1)
    await h.pipeline.drain()

    expect(h.statusEvents().map((event) => `${event.from}>${event.to}`)).toEqual([
      'pending>discussing',
      'discussing>ready',
      'ready>sending',
      'sending>sent',
    ])
  })

  it('草稿为空字符串也算「生成成功」，由 Gate 的 S6 去拦（管线不越权判内容）', async () => {
    const h = harness({
      jobs: [job()],
      reply: '',
      decision: () => ({ action: 'skip', reason: 'empty', detail: '草稿为空' }),
    })
    h.pipeline.start()
    h.pipeline.enqueue(1)
    await h.pipeline.drain()

    expect(h.repo.mocks.commitDraft).toHaveBeenCalledTimes(1)
    expect(h.repo.mocks.skipJob).toHaveBeenCalledWith(1, 'empty')
  })

  it('已终态（sent/skipped）的 job 重复入队直接跳过，不再调 Agent', async () => {
    for (const status of ['sent', 'skipped'] as const) {
      const h = harness({ jobs: [job({ status })] })
      h.pipeline.start()
      h.pipeline.enqueue(1)
      await h.pipeline.drain()
      expect(h.agent.complete).not.toHaveBeenCalled()
      expect(h.repo.mocks.commitDraft).not.toHaveBeenCalled()
    }
  })

  it('job 不存在时安全退出（不抛、不写库）', async () => {
    const h = harness()
    h.pipeline.start()
    h.pipeline.enqueue(999)
    await expect(h.pipeline.drain()).resolves.toBe(1)
    expect(h.agent.complete).not.toHaveBeenCalled()
  })

  it('markStatus 未生效且库中也不是 discussing → 放弃（已被别的 worker 抢走）', async () => {
    const h = harness({ jobs: [job({ status: 'ready', draft: '别人写好的草稿' })] })
    h.pipeline.start()
    h.pipeline.enqueue(1)
    await pump(h)
    // ready → 分流进外发队列，**不会**去调 Agent 覆盖已有草稿
    expect(h.agent.complete).not.toHaveBeenCalled()
    expect(h.repo.mocks.commitDraft).not.toHaveBeenCalled()
    expect(jobOf(h, 1).status).toBe('sent')
  })

  it('库中已是 discussing（崩溃恢复留下的）→ 继续生成，不会重复 markStatus', async () => {
    const h = harness({ jobs: [job({ status: 'discussing' })] })
    h.pipeline.start()
    h.pipeline.enqueue(1)
    await pump(h)
    // markStatus 拿不到锁（状态不是 pending）→ moved=false，但已在 discussing 故继续
    expect(h.repo.mocks.markStatus).toHaveBeenCalledWith(1, 'discussing', 'pending')
    expect(h.agent.complete).toHaveBeenCalledTimes(1)
    expect(jobOf(h, 1).status).toBe('sent')
  })

  it('会话已删除时不调 recentContext，提示词走 targetFallback', async () => {
    const h = harness({ jobs: [job()], conversations: [], sendImpl: async () => ({ msgUid: 'u1' }) })
    h.pipeline.start()
    h.pipeline.enqueue(1)
    await h.pipeline.drain()

    expect(h.repo.mocks.recentContext).not.toHaveBeenCalled()
    expect(h.agent.calls[0]).toContain('【目标会话】研发一组') // targetTitle 兜底
    // 会话没了 → 不推 messagesAppended（没有 convPk 可挂）
    expect(h.events.some((event) => event.type === 'messagesAppended')).toBe(false)
  })

  it('commitDraft 未生效时不入外发队列（防并发双入队 → 双发）', async () => {
    const h = harness({ jobs: [job()] })
    h.repo.mocks.commitDraft.mockResolvedValueOnce(false)
    h.pipeline.start()
    h.pipeline.enqueue(1)
    await h.pipeline.drain()
    expect(h.pipeline.pending()).toEqual({ generate: 0, send: 0 })
  })
})

function settingsMaxContext(): number {
  return DEFAULT_WELINK_SETTINGS.agent.maxContextMsgs
}

// ---------------------------------------------------------------- 生成段：失败与重试

describe('orchestrator/pipeline —— 生成段失败与重试', () => {
  it(`生成失败未耗尽（attempts < ${MAX_ATTEMPTS}）→ 回 pending 并重新入队`, async () => {
    const h = harness({ jobs: [job({ attempts: 0 })] })
    h.agent.complete.mockRejectedValue(new Error('连接被拒绝'))
    h.pipeline.start()
    h.pipeline.enqueue(1)
    await pump(h)

    const [pk, status, error] = h.repo.mocks.recordAttemptFailure.mock.calls[0]
    expect(pk).toBe(1)
    expect(status).toBe('pending')
    expect(error).toContain('连接被拒绝')
    // 已重新入队（attempts 递增后仍在重试窗口内）
    expect(h.pipeline.pending().generate).toBeGreaterThan(0)
  })

  it('失败重试以**库中 attempts + 1** 为准（崩溃后本地计数不可信）', async () => {
    // 库里已是第 2 次（attempts=2）→ attempts+1=3 不满足 <3 → 直接失败
    const h = harness({ jobs: [job({ attempts: MAX_ATTEMPTS - 1 })] })
    h.agent.complete.mockRejectedValueOnce(new Error('超时'))
    h.pipeline.start()
    h.pipeline.enqueue(1)
    await h.pipeline.drain()

    expect(h.repo.mocks.recordAttemptFailure).toHaveBeenCalledWith(1, 'failed', expect.stringContaining('超时'))
    expect(jobOf(h, 1).status).toBe('failed')
  })

  it('失败重试带 1500ms 延时（不立刻空转重试）', async () => {
    const h = harness({ jobs: [job()] })
    h.agent.complete.mockRejectedValue(new Error('boom'))
    h.pipeline.start()
    h.pipeline.enqueue(1)
    await settle()
    // 先放掉 enqueue 排下的那个 0ms 冲刷，让第 1 次生成真的跑起来并失败
    h.scheduler.advance(0)
    await settle(120)
    // 第 1 次生成失败后入队的重试：1500ms 之后（不是 0ms 空转）
    expect(h.scheduler.queued).toBe(1)
    expect(h.scheduler.nextAt()).toBe(1500)

    h.scheduler.advance(1500)
    await settle(120)
    // 退避翻倍：第 2 次失败后排到「当下 + 3000ms」（而非同一个 1500ms 原地打转）
    expect(h.scheduler.nextAt()).toBe(h.scheduler.now() + 3000)
  })

  it(`重试满 ${MAX_ATTEMPTS} 次后转 failed 并停止排队`, async () => {
    const h = harness({ jobs: [job({ attempts: 0 })] })
    h.agent.complete.mockRejectedValue(new Error('一直失败'))
    h.pipeline.start()
    h.pipeline.enqueue(1)
    await settle()
    // 逐次放行重试定时器
    for (let index = 0; index < MAX_ATTEMPTS + 2; index += 1) {
      h.scheduler.advance(1500)
      await settle()
    }
    expect(h.agent.complete).toHaveBeenCalledTimes(MAX_ATTEMPTS)
    expect(jobOf(h, 1).status).toBe('failed')
    expect(h.pipeline.pending().generate).toBe(0)
  })

  it('AgentError 的错误分类被写进 last_error（timeout 与 error 可区分）', async () => {
    const { AgentError } = await import('@/infra/agent')
    const h = harness({ jobs: [job({ attempts: MAX_ATTEMPTS - 1 })] })
    h.agent.complete.mockRejectedValueOnce(new AgentError('模型服务超时', 'timeout'))
    h.pipeline.start()
    h.pipeline.enqueue(1)
    await h.pipeline.drain()
    expect(h.repo.mocks.recordAttemptFailure.mock.calls[0][2]).toContain('timeout')
  })
})

// ---------------------------------------------------------------- 生成段：Agent 留痕归属

describe('orchestrator/pipeline —— Agent 调用留痕归属（R4）', () => {
  it('录音回调按 prompt 精确匹配到 job，落 agent_logs', async () => {
    const h = harness({ jobs: [job()], sendImpl: async () => ({ msgUid: 'u1' }) })
    h.pipeline.start()
    h.pipeline.enqueue(1)
    await h.pipeline.drain()

    expect(h.repo.agentLogs).toHaveLength(1)
    expect(h.repo.agentLogs[0]).toMatchObject({ jobPk: 1, status: 'ok' })
    expect(h.repo.agentLogs[0].prompt).toBe(h.agent.calls[0])
  })

  it('prompt 对不上的录音不落库（并发下绝不串台到别的 job）', async () => {
    const h = harness({ jobs: [job({ status: 'sent' })] })
    h.pipeline.start()
    h.agent.emitCall({ prompt: '从来没见过的提示词', response: 'x' })
    await settle()
    expect(h.repo.mocks.insertAgentLog).not.toHaveBeenCalled()
  })

  it('失败调用也留痕（status=error，R4 要能回溯失败语料）', async () => {
    // 用 autoComplete:false 把第一次调用**卡在生成段中间**，此时归属槽已登记，
    // 可以手动推一次失败的录音（真实客户端「失败也回调」的时序）
    const h = harness({ jobs: [job({ attempts: 0 })], autoComplete: false })
    h.pipeline.start()
    h.pipeline.enqueue(1)
    // 放掉 0ms 冲刷，让 generateOne 跑到 await complete（归属槽已入队）
    h.scheduler.advance(0)
    await settle()
    expect(h.agent.complete).toHaveBeenCalledTimes(1)

    const prompt = h.agent.calls[0]
    h.agent.emitCall({ prompt, response: '', status: 'error', error: '连接被拒绝' })
    await settle()
    expect(h.repo.agentLogs.some((log) => log.status === 'error')).toBe(true)
  })

  it('同一 job 的录音槽在调用结束后回收（数组不无限增长）', async () => {
    const h = harness({
      jobs: [job({ pk: 1 }), job({ pk: 2 })],
      reply: (prompt) => prompt.slice(0, 5),
      sendImpl: async () => ({ msgUid: 'u' }),
    })
    h.pipeline.start()
    h.pipeline.enqueueMany([1, 2])
    await h.pipeline.drain()
    // 跑到第二次、第三次时旧槽已回收 → 仍是精确归属（1 与 2 各一条）
    expect(new Set(h.repo.agentLogs.map((log) => log.jobPk))).toEqual(new Set([1, 2]))
  })

  it('落库失败只 warn，不影响外发（留痕不是关键路径）', async () => {
    const h = harness({ jobs: [job()], sendImpl: async () => ({ msgUid: 'u1' }) })
    h.repo.mocks.insertAgentLog.mockRejectedValueOnce(new Error('磁盘满'))
    h.pipeline.start()
    h.pipeline.enqueue(1)
    await expect(h.pipeline.drain()).resolves.toBeGreaterThan(0)
    expect(jobOf(h, 1).status).toBe('sent')
  })
})

// ---------------------------------------------------------------- 外发段：正常与拦截

describe('orchestrator/pipeline —— 外发段 Gate 四路决策', () => {
  it('放行：乐观锁置 sending → send → markSent（单事务）→ onSent 扣配额', async () => {
    const h = harness({ jobs: [job({ status: 'pending' })] })
    h.pipeline.start()
    h.pipeline.enqueue(1)
    await pump(h)

    expect(h.repo.mocks.markStatus).toHaveBeenCalledWith(1, 'sending', 'ready')
    expect(h.port.send).toHaveBeenCalledWith({ convId: 'G-1001', convType: 'group' }, '收到，我看一下，稍后回复你。')
    const receipt = h.repo.sentReceipts.get(1)!
    expect(receipt.msgUid).toBe('uid-收到，我看一下，稍后回复你。')
    expect(receipt.content).toBe('收到，我看一下，稍后回复你。')
    expect(receipt.convPk).toBe(1)
    // S5：senderId 取自触发消息（contextMessage 默认 E-9001），不再传空串
    expect(h.gate.onSent).toHaveBeenCalledWith('G-1001', 'E-9001')
    expect(jobOf(h, 1).status).toBe('sent')
  })

  it('放行后推 messagesAppended（自己发的那条立刻可见）', async () => {
    const h = harness({ jobs: [job({ status: 'pending' })] })
    h.pipeline.start()
    h.pipeline.enqueue(1)
    await pump(h)

    const event = h.events.find((item) => item.type === 'messagesAppended') as {
      convId: string
      messages: Array<{ direction: string; content: string }>
    }
    expect(event.convId).toBe('G-1001')
    expect(event.messages[0]).toMatchObject({ direction: 'out', content: '收到，我看一下，稍后回复你。' })
  })

  it('skip：status=skipped + skip_reason 同条留痕，不调 port.send', async () => {
    const h = harness({
      jobs: [job({ status: 'ready', draft: '草稿' })],
      decision: () => ({ action: 'skip', reason: 'rate_conv_hourly', detail: '该会话本小时配额已满' }),
    })
    h.pipeline.start()
    h.pipeline.enqueue(1)
    await h.pipeline.drain()

    expect(h.repo.mocks.skipJob).toHaveBeenCalledWith(1, 'rate_conv_hourly')
    expect(h.port.send).not.toHaveBeenCalled()
    expect(h.gate.onSent).not.toHaveBeenCalled()
    expect(jobOf(h, 1).status).toBe('skipped')
    expect(h.statusEvents().at(-1)).toMatchObject({ to: 'skipped' })
  })

  it('hold：停 ready + hold_reason（进待审队列 O7），不调 port.send', async () => {
    const h = harness({
      jobs: [job({ status: 'ready', draft: '保证一定赔偿' })],
      decision: () => ({ action: 'hold', reason: 'blacklist', detail: '命中敏感句式待审' }),
    })
    h.pipeline.start()
    h.pipeline.enqueue(1)
    await h.pipeline.drain()

    expect(h.repo.mocks.holdJob).toHaveBeenCalledWith(1, 'blacklist')
    expect(h.port.send).not.toHaveBeenCalled()
    expect(jobOf(h, 1)).toMatchObject({ status: 'ready', holdReason: 'blacklist' })
  })

  it('defer 短期（静默时段）：回 ready 并重排 30s 后再试', async () => {
    const h = harness({
      jobs: [job({ status: 'ready', draft: '草稿' })],
      decision: () => ({ action: 'defer', reason: 'quiet', detail: '静默时段', terminal: false }),
    })
    h.pipeline.start()
    h.pipeline.enqueue(1)
    await pump(h)

    expect(h.repo.mocks.suspendJob).toHaveBeenCalledWith(1)
    expect(jobOf(h, 1)).toMatchObject({ status: 'ready', holdReason: '' })
    // 0ms 冲刷定时器已消费完，只剩重试排程 —— 落在 30s（而非 0ms 空转）
    expect(h.scheduler.queued).toBe(1)
    expect(h.scheduler.nextAt()).toBe(h.scheduler.now() + 30_000)
  })

  it('defer 长期（会话静音 terminal）：回 ready 但不重排（等下次入队更省）', async () => {
    const h = harness({
      jobs: [job({ status: 'ready', draft: '草稿' })],
      decision: () => ({ action: 'defer', reason: 'quiet', detail: '会话静音', terminal: true }),
    })
    h.pipeline.start()
    h.pipeline.enqueue(1)
    await pump(h)
    expect(h.repo.mocks.suspendJob).toHaveBeenCalledWith(1)
    // 没有排任何定时器（terminal 挂起不重排，避免每个 tick 无意义刷库）
    expect(h.scheduler.queued).toBe(0)
    // 但它留在外发队列里，等下一次入队/刷新时再判
    expect(h.pipeline.pending().send).toBe(1)
  })

  it('每路决策后都推一次 safetyChanged（控制条徽标要跟着变）', async () => {
    const h = harness({
      jobs: [job({ status: 'ready', draft: '草稿' })],
      decision: () => ({ action: 'skip', reason: 'fused', detail: '熔断中' }),
    })
    h.pipeline.start()
    h.pipeline.enqueue(1)
    await h.pipeline.drain()
    expect(h.events.some((event) => event.type === 'safetyChanged')).toBe(true)
  })

  it('悲观时 Gate 判定在乐观锁之前（拦截不应白占 sending 锁）', async () => {
    const h = harness({
      jobs: [job({ status: 'ready', draft: '草稿' })],
      decision: () => ({ action: 'skip', reason: 'disabled', detail: '总开关关闭' }),
    })
    h.pipeline.start()
    h.pipeline.enqueue(1)
    await h.pipeline.drain()
    expect(h.repo.mocks.markStatus).not.toHaveBeenCalledWith(1, 'sending', 'ready')
  })

  it('非 ready 状态的 job 不进 Gate（sendNow 只接受有草稿的可发状态）', async () => {
    const h = harness({ jobs: [job({ status: 'pending', draft: '草稿' })] })
    h.pipeline.start()
    // pending 说明草稿还没生成完（或生成段正在处理）→ 人工通道直接拒绝，
    // 不该硬塞进外发队列让 sendOne 的前置检查白跑
    expect(await h.pipeline.sendNow(1)).toBe(false)
    await h.pipeline.drain()
    expect(h.gate.check).not.toHaveBeenCalled()
  })

  it('sending / sent 状态的人工发送也被拒（已在处理中或已完成）', async () => {
    for (const status of ['sending', 'sent'] as const) {
      const h = harness({ jobs: [job({ status, draft: '草稿' })] })
      h.pipeline.start()
      expect(await h.pipeline.sendNow(1)).toBe(false)
    }
  })

  it('乐观锁未拿到（并发/重复投递）→ 不发、不记账', async () => {
    const h = harness({ jobs: [job({ status: 'ready', draft: '草稿' })] })
    h.repo.mocks.markStatus.mockResolvedValue(false)
    h.pipeline.start()
    h.pipeline.enqueue(1)
    await h.pipeline.drain()
    expect(h.port.send).not.toHaveBeenCalled()
    expect(h.repo.mocks.markSent).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------- 外发段：人工模式

describe('orchestrator/pipeline —— 人工模式（manual）', () => {
  it('manual_mode 默认不外发：停 ready + hold_reason=manual_mode', async () => {
    const h = harness({ jobs: [job({ status: 'ready', draft: '草稿', sendModeUsed: 'manual' })] })
    h.pipeline.start()
    h.pipeline.enqueue(1)
    await h.pipeline.drain()

    expect(h.repo.mocks.holdJob).toHaveBeenCalledWith(1, 'manual_mode')
    expect(h.port.send).not.toHaveBeenCalled()
    expect(h.gate.check).not.toHaveBeenCalled()
  })

  it('sendNow 绕过 manual 拦截，但其余 Gate 规则照走', async () => {
    const h = harness({
      jobs: [job({ status: 'ready', draft: '草稿', sendModeUsed: 'manual' })],
      sendImpl: async () => ({ msgUid: 'u1' }),
    })
    h.pipeline.start()
    expect(await h.pipeline.sendNow(1)).toBe(true)
    await h.pipeline.drain()

    expect(h.gate.check).toHaveBeenCalledTimes(1)
    expect(h.port.send).toHaveBeenCalledTimes(1)
    expect(jobOf(h, 1).status).toBe('sent')
  })

  it('sendNow 时草稿为空 → 拒绝（库中无草稿不得外发，要点3）', async () => {
    const h = harness({ jobs: [job({ status: 'ready', draft: '   ' })] })
    h.pipeline.start()
    expect(await h.pipeline.sendNow(1)).toBe(false)
    expect(h.port.send).not.toHaveBeenCalled()
  })

  it('sendNow 对不存在的 job 返回 false', async () => {
    const h = harness()
    h.pipeline.start()
    expect(await h.pipeline.sendNow(404)).toBe(false)
  })

  it('sendNow 对 submitted（pending）状态的 job 返回 false（必须先有草稿）', async () => {
    const h = harness({ jobs: [job({ status: 'pending', draft: '草稿' })] })
    h.pipeline.start()
    expect(await h.pipeline.sendNow(1)).toBe(false)
  })

  it('sendNow 对 failed 先 requeueJob 再入外发队列', async () => {
    const h = harness({
      jobs: [job({ status: 'failed', draft: '草稿' })],
      sendImpl: async () => ({ msgUid: 'u1' }),
    })
    h.pipeline.start()
    expect(await h.pipeline.sendNow(1)).toBe(true)
    expect(h.repo.mocks.requeueJob).toHaveBeenCalledWith(1)
    await h.pipeline.drain()
    expect(h.port.send).toHaveBeenCalledTimes(1)
  })

  it('requeueJob 未生效（状态被改）时 sendNow 返回 false', async () => {
    const h = harness({ jobs: [job({ status: 'skipped', draft: '草稿' })] })
    h.repo.mocks.requeueJob.mockResolvedValueOnce(false)
    h.pipeline.start()
    expect(await h.pipeline.sendNow(1)).toBe(false)
  })

  it('sendNow 的越权标记是一次性的（下一次自动外发仍会被 manual 拦）', async () => {
    const h = harness({
      jobs: [job({ status: 'ready', draft: '草稿', sendModeUsed: 'manual' })],
      sendImpl: async () => ({ msgUid: 'u1' }),
    })
    h.pipeline.start()
    await h.pipeline.sendNow(1)
    await h.pipeline.drain()
    // 已发送 → 再次入队不再重复外发
    h.pipeline.enqueue(1)
    await h.pipeline.drain()
    expect(h.port.send).toHaveBeenCalledTimes(1)
  })
})

// ---------------------------------------------------------------- 外发段：失败与防双发

describe('orchestrator/pipeline —— 外发失败与防双发', () => {
  it(`发送失败未耗尽 → 回 ready 并重试（≤${MAX_SEND_ATTEMPTS} 次）`, async () => {
    const h = harness({
      jobs: [job({ status: 'ready', draft: '草稿' })],
      sendImpl: async () => {
        throw new Error('CLI 退出码 1')
      },
    })
    h.pipeline.start()
    h.pipeline.enqueue(1)
    await pump(h)

    expect(h.repo.mocks.recordAttemptFailure).toHaveBeenCalledWith(1, 'ready', expect.stringContaining('CLI 退出码 1'))
    expect(jobOf(h, 1).status).toBe('ready')
    expect(h.gate.onSent).not.toHaveBeenCalled()
    // 重试排在 attempts×5000 = 5000ms 之后
    expect(h.scheduler.nextAt()).toBe(h.scheduler.now() + 5000)
  })

  it(`发送重试满 ${MAX_SEND_ATTEMPTS} 次 → failed 交人工`, async () => {
    const h = harness({
      jobs: [job({ status: 'ready', draft: '草稿' })],
      sendImpl: async () => {
        throw new Error('永远失败')
      },
    })
    h.pipeline.start()
    h.pipeline.enqueue(1)
    await h.pipeline.drain()
    // drain 会把重试定时器一路放行
    for (let index = 0; index < MAX_SEND_ATTEMPTS + 2; index += 1) {
      h.scheduler.advance(60_000)
      await settle()
    }
    expect(h.port.send).toHaveBeenCalledTimes(MAX_SEND_ATTEMPTS)
    expect(jobOf(h, 1).status).toBe('failed')
  })

  it('发送报错但存在回执 → 补记 sent 并计配额（绝不重发，否则群里两条一样的）', async () => {
    const h = harness({
      jobs: [job({ status: 'ready', draft: '草稿' })],
      sendImpl: async () => {
        throw new Error('响应超时，但服务端可能已收到')
      },
    })
    // 模拟「上一次发出去了但没记上」
    h.repo.receipts.add(1)
    h.pipeline.start()
    h.pipeline.enqueue(1)
    await h.pipeline.drain()

    expect(h.repo.mocks.markStatus).toHaveBeenCalledWith(1, 'sent', 'sending')
    // S5：补记路径同样要带 senderId（供 Gate 的 S5 同人短窗合并记账）
    expect(h.gate.onSent).toHaveBeenCalledWith('G-1001', 'E-9001')
    expect(h.repo.mocks.recordAttemptFailure).not.toHaveBeenCalled()
    expect(jobOf(h, 1).status).toBe('sent')
  })

  it('markSent 未生效时不扣配额、不推 messagesAppended（避免记账重复）', async () => {
    const h = harness({ jobs: [job({ status: 'pending' })] })
    h.repo.mocks.markSent.mockResolvedValueOnce(false)
    h.pipeline.start()
    h.pipeline.enqueue(1)
    await pump(h)

    expect(h.gate.onSent).not.toHaveBeenCalled()
    expect(h.events.some((event) => event.type === 'messagesAppended')).toBe(false)
  })

  it('配额只在发送成功后扣减（失败不吃配额）', async () => {
    const h = harness({
      jobs: [job({ status: 'ready', draft: '草稿' })],
      sendImpl: async () => {
        throw new Error('失败')
      },
    })
    h.pipeline.start()
    h.pipeline.enqueue(1)
    await h.pipeline.drain()
    expect(h.gate.onSent).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------- 崩溃恢复

describe('orchestrator/pipeline —— 崩溃恢复（§6.3）', () => {
  it('库里残留 sending + 有回执 → 补记 sent（不重复写消息、不动配额）', async () => {
    const h = harness({ jobs: [job({ status: 'sending', draft: '草稿' })] })
    h.repo.receipts.add(1)
    h.pipeline.start()
    h.pipeline.enqueue(1)
    await h.pipeline.drain()

    expect(h.repo.mocks.markStatus).toHaveBeenCalledWith(1, 'sent', 'sending')
    expect(h.port.send).not.toHaveBeenCalled()
    // 崩溃恢复的立场：只有证据确凿的成功才动配额，补记不动
    expect(h.gate.onSent).not.toHaveBeenCalled()
    expect(h.statusEvents().at(-1)).toMatchObject({ from: 'sending', to: 'sent' })
  })

  it('库里残留 sending + 无回执 → 回落 ready 并**重新排队**（不当作已发）', async () => {
    const h = harness({ jobs: [job({ status: 'sending', draft: '草稿' })] })
    h.pipeline.start()
    h.pipeline.enqueue(1)
    await pump(h)

    expect(h.repo.mocks.suspendJob).toHaveBeenCalledWith(1)
    // 这条断言守住一个真实缺陷：早期版本只改状态不排队，那条草稿就
    // 永远发不出去（重启后静默丢失）
    expect(h.pipeline.pending().send).toBe(1)
    expect(h.port.send).not.toHaveBeenCalled()
    // 已排 30s 后的重试
    expect(h.scheduler.nextAt()).toBe(h.scheduler.now() + 30_000)
  })

  it('恢复补记未生效（被并发处理）时不重复发事件', async () => {
    const h = harness({ jobs: [job({ status: 'sending', draft: '草稿' })] })
    h.repo.receipts.add(1)
    h.repo.mocks.markStatus.mockResolvedValueOnce(false)
    h.pipeline.start()
    h.pipeline.enqueue(1)
    await h.pipeline.drain()
    expect(h.port.send).not.toHaveBeenCalled()
  })

  it('重启后 enqueueMany 把未终态任务全量接回', async () => {
    const h = harness({
      jobs: [
        job({ pk: 1, status: 'pending' }),
        job({ pk: 2, status: 'discussing' }),
        job({ pk: 3, status: 'ready', draft: '草稿' }),
      ],
      reply: '收到',
      sendImpl: async () => ({ msgUid: 'u' }),
    })
    h.pipeline.start()
    h.pipeline.enqueueMany([1, 2, 3])
    await h.pipeline.drain()
    expect(jobOf(h, 1).status).toBe('sent')
    expect(jobOf(h, 2).status).toBe('sent')
    expect(jobOf(h, 3).status).toBe('sent')
  })
})

// ---------------------------------------------------------------- 并发不变量

describe('orchestrator/pipeline —— 并发不变量（O1/D12）', () => {
  it(`生成段并发不超过 ${GENERATE_CONCURRENCY}`, async () => {
    const h = harness({
      jobs: [job({ pk: 1 }), job({ pk: 2 }), job({ pk: 3 })],
      autoComplete: false,
      sendImpl: async () => ({ msgUid: 'u' }),
    })
    h.pipeline.start()
    h.pipeline.enqueueMany([1, 2, 3])
    const draining = h.pipeline.drain()
    await settle()

    expect(h.agent.active).toBe(GENERATE_CONCURRENCY)
    expect(h.agent.complete).toHaveBeenCalledTimes(GENERATE_CONCURRENCY)

    h.agent.releaseAll()
    await draining
    expect(h.agent.complete).toHaveBeenCalledTimes(3)
    expect(h.agent.maxActive).toBe(GENERATE_CONCURRENCY)
  })

  it('外发段严格串行：第 2 条不会与第 1 条并行发出', async () => {
    const h = harness({
      jobs: [job({ pk: 1, status: 'ready', draft: 'A' }), job({ pk: 2, status: 'ready', draft: 'B' })],
      manualSend: true,
    })
    h.pipeline.start()
    // 直接进外发队列（绕过生成段，聚焦发送串行）
    await h.pipeline.sendNow(1)
    await h.pipeline.sendNow(2)
    const draining = h.pipeline.drain()
    await settle()

    expect(h.port.sendCalls).toEqual(['A'])
    expect(h.port.maxActive).toBe(1)

    h.port.releaseAll()
    await settle()
    // 第 1 条完成后才轮到第 2 条
    expect(h.port.sendCalls).toEqual(['A', 'B'])
    expect(h.port.maxActive).toBe(1)

    h.port.releaseAll()
    await draining
    expect(h.port.maxActive).toBe(1)
  })

  it('外发进行中时另一路 flush 不会抢走队列（sendActive 是唯一闸门）', async () => {
    const h = harness({
      jobs: [job({ pk: 1, status: 'ready', draft: 'A' }), job({ pk: 2, status: 'ready', draft: 'B' })],
      manualSend: true,
    })
    h.pipeline.start()
    await h.pipeline.sendNow(1)
    await h.pipeline.sendNow(2)
    const draining = h.pipeline.drain()
    await settle()
    // 发送 1 正卡在 port.send；此时触发排队的 flush
    expect(h.port.sendCalls).toEqual(['A'])
    h.scheduler.advance(0)
    await settle()
    // 仍然只有 1 次发送 —— 第二路 flush 被 sendActive 挡住
    expect(h.port.sendCalls).toEqual(['A'])
    h.port.releaseAll()
    await settle()
    h.port.releaseAll()
    await draining
    expect(h.port.sendCalls).toEqual(['A', 'B'])
  })

  it('同一 jobPk 重复入队只处理一次（去重）', async () => {
    const h = harness({ jobs: [job()], sendImpl: async () => ({ msgUid: 'u1' }) })
    h.pipeline.start()
    h.pipeline.enqueue(1)
    h.pipeline.enqueue(1)
    h.pipeline.enqueue(1)
    await h.pipeline.drain()
    expect(h.agent.complete).toHaveBeenCalledTimes(1)
    expect(h.port.send).toHaveBeenCalledTimes(1)
  })

  it('enqueueMany 内部也去重', async () => {
    const h = harness({ jobs: [job()], sendImpl: async () => ({ msgUid: 'u1' }) })
    h.pipeline.start()
    h.pipeline.enqueueMany([1, 1, 1])
    await h.pipeline.drain()
    expect(h.agent.complete).toHaveBeenCalledTimes(1)
  })

  it('start 幂等：重复调用不会重复排程', async () => {
    const h = harness()
    h.pipeline.start()
    h.pipeline.start()
    expect(h.pipeline.running()).toBe(true)
  })

  it('未 start 时 enqueue 不排程，drain 不干活', async () => {
    const h = harness({ jobs: [job()] })
    h.pipeline.enqueue(1)
    expect(h.scheduler.queued).toBe(0)
    expect(await h.pipeline.drain()).toBe(0)
    expect(h.agent.complete).not.toHaveBeenCalled()
  })

  it('stop 后不再消费队列（未完成任务保留在库中）', async () => {
    const h = harness({ jobs: [job()] })
    h.pipeline.start()
    h.pipeline.stop()
    expect(h.pipeline.running()).toBe(false)
    expect(await h.pipeline.drain()).toBe(0)
    expect(h.scheduler.queued).toBe(0)
  })

  it('pending() 同时反映队列长度与在飞任务', async () => {
    const h = harness({ jobs: [job({ pk: 1 }), job({ pk: 2 }), job({ pk: 3 })], autoComplete: false })
    h.pipeline.start()
    h.pipeline.enqueueMany([1, 2, 3])
    const draining = h.pipeline.drain()
    await settle()
    // 2 个在飞 + 1 个排队 = 3
    expect(h.pipeline.pending().generate).toBe(3)
    h.agent.releaseAll()
    await draining
    expect(h.pipeline.pending().generate).toBe(0)
  })

  it('生成段异常（底层抛）不影响其他 job', async () => {
    const h = harness({ jobs: [job({ pk: 1 }), job({ pk: 2 })] })
    h.repo.mocks.getConversation.mockRejectedValueOnce(new Error('库挂了'))
    h.pipeline.start()
    h.pipeline.enqueueMany([1, 2])
    await pump(h)
    // job 2 仍应被处理（job 1 的异常被 catch 隔离）
    expect(h.agent.complete).toHaveBeenCalledTimes(1)
    expect(jobOf(h, 2).status).toBe('sent')
  })

  it('外发段异常（底层抛）被隔离，后续任务继续', async () => {
    const h = harness({
      jobs: [job({ pk: 1, status: 'ready', draft: 'A' }), job({ pk: 2, status: 'ready', draft: 'B' })],
    })
    h.repo.mocks.markStatus.mockRejectedValueOnce(new Error('库挂了'))
    h.pipeline.start()
    await h.pipeline.sendNow(1)
    await h.pipeline.sendNow(2)
    await h.pipeline.drain()
    expect(h.port.send).toHaveBeenCalledTimes(1)
  })

  it('外发段异常（底层抛）被隔离，后续任务继续', async () => {
    const h = harness({
      jobs: [job({ pk: 1, status: 'ready', draft: 'A' }), job({ pk: 2, status: 'ready', draft: 'B' })],
    })
    h.repo.mocks.markStatus.mockRejectedValueOnce(new Error('库挂了'))
    h.pipeline.start()
    await h.pipeline.sendNow(1)
    await h.pipeline.sendNow(2)
    await h.pipeline.drain()
    expect(h.port.send).toHaveBeenCalledTimes(1)
  })
})

// ---------------------------------------------------------------- 技能路由（skill-routing）

describe('orchestrator/pipeline —— 技能路由接入（skill-routing）', () => {
  function skill(overrides: Partial<WelinkSkill> = {}): WelinkSkill {
    return {
      id: 'fault-fix',
      name: '故障咨询',
      description: '系统报错类问题',
      enabled: true,
      keywords: ['报错'],
      promptTemplate: '故障技能模板 {{question}}',
      knowledge: '',
      reviewMode: 'auto',
      retrieval: { enabled: false },
      knowledgeDocs: [],
      ...overrides,
    }
  }

  function skillSettings(skills: WelinkSkill[], llmClassifyFallback = true): Partial<WelinkSettings> {
    return { agent: { ...DEFAULT_WELINK_SETTINGS.agent, skills, llmClassifyFallback } }
  }

  it('未配置技能时行为与升级前一致：兜底模板即原 promptTemplate，零分类调用', async () => {
    const h = harness({ jobs: [job()], sendImpl: async () => ({ msgUid: 'u1' }) })
    h.pipeline.start()
    h.pipeline.enqueue(1)
    await h.pipeline.drain()
    expect(h.agent.complete).toHaveBeenCalledTimes(1)
    expect(h.agent.calls[0]).toContain('【需要回复的消息】')
    expect(jobOf(h, 1)).toMatchObject({ skillId: 'fallback', skillName: '通用助手', skillSource: 'fallback' })
  })

  it('规则命中：按技能模板渲染（含知识块），三列随草稿同条落库，不发起分类调用', async () => {
    const fault = skill({
      keywords: ['500'],
      promptTemplate: '故障技能模板 {{knowledge}} {{question}}',
      knowledge: '500 是服务端错误口径',
    })
    const h = harness({
      jobs: [job()],
      settings: skillSettings([fault]),
      reply: (prompt) => (prompt.includes('故障技能模板') ? '故障回复' : '通用回复'),
    })
    h.pipeline.start()
    h.pipeline.enqueue(1)
    await h.pipeline.drain()
    expect(h.agent.complete).toHaveBeenCalledTimes(1)
    expect(h.agent.calls[0]).toContain('故障技能模板')
    expect(h.agent.calls[0]).toContain('500 是服务端错误口径')
    // drain 跑完整链：Gate 默认放行 → sent
    expect(jobOf(h, 1)).toMatchObject({
      status: 'sent',
      skillId: 'fault-fix',
      skillName: '故障咨询',
      skillSource: 'rule',
    })
  })

  it('规则未命中 + LLM 分类命中：分类与生成两条 agent_logs，草稿用命中技能模板', async () => {
    // 触发消息「看下接口报 500 的问题」不含「报错」关键词 → 走 LLM 分类
    const fault = skill({ keywords: ['报错'] })
    const h = harness({
      jobs: [job()],
      settings: skillSettings([fault]),
      reply: (prompt) =>
        prompt.startsWith('你是消息分类器') ? 'fault-fix' : prompt.includes('故障技能模板') ? '故障回复' : '通用回复',
    })
    h.pipeline.start()
    h.pipeline.enqueue(1)
    await h.pipeline.drain()
    expect(h.agent.complete).toHaveBeenCalledTimes(2)
    expect(h.agent.calls[0].startsWith('你是消息分类器')).toBe(true)
    expect(h.agent.calls[1]).toContain('故障技能模板')
    expect(h.repo.mocks.insertAgentLog).toHaveBeenCalledTimes(2)
    expect(jobOf(h, 1)).toMatchObject({ status: 'sent', skillId: 'fault-fix', skillSource: 'llm' })
  })

  it('reviewMode=manual 的技能：草稿落库后转审（skill_review），不入自动外发队列', async () => {
    const reviewed = skill({ keywords: ['500'], reviewMode: 'manual' })
    const h = harness({ jobs: [job()], settings: skillSettings([reviewed]) })
    h.pipeline.start()
    h.pipeline.enqueue(1)
    await h.pipeline.drain()
    expect(h.repo.mocks.holdJob).toHaveBeenCalledWith(1, 'skill_review')
    expect(jobOf(h, 1)).toMatchObject({ status: 'ready', draft: '收到，我看一下，稍后回复你。', holdReason: 'skill_review' })
    expect(h.port.send).not.toHaveBeenCalled()
    const transition = h.events.find(
      (event) => event.type === 'jobStatusChanged' && (event as { holdReason?: string }).holdReason === 'skill_review',
    )
    expect(transition).toBeDefined()
  })

  it('skill_review 转审的草稿可人工放行（sendNow），Gate 其余规则照走', async () => {
    const h = harness({ jobs: [job({ pk: 1, status: 'ready', draft: '技能草稿', holdReason: 'skill_review' })] })
    h.pipeline.start()
    await h.pipeline.sendNow(1)
    await h.pipeline.drain()
    expect(h.port.send).toHaveBeenCalledWith({ convId: 'G-1001', convType: 'group' }, '技能草稿')
    expect(jobOf(h, 1).status).toBe('sent')
  })

  it('技能模板为空时回退兜底模板（归一化允许空串，D4）', async () => {
    const empty = skill({ keywords: ['500'], promptTemplate: '  ' })
    const h = harness({ jobs: [job()], settings: skillSettings([empty]) })
    h.pipeline.start()
    h.pipeline.enqueue(1)
    await h.pipeline.drain()
    expect(h.agent.calls[0]).toContain('【需要回复的消息】')
    expect(h.agent.calls[0]).not.toContain('故障技能模板')
    expect(jobOf(h, 1).skillId).toBe('fault-fix')
  })
})

// ---------------------------------------------------------------- 知识检索注入（rag-retrieval）

describe('orchestrator/pipeline —— 知识检索注入（rag-retrieval）', () => {
  /** 可控的 RAG 假件：记录查询，按脚本返回片段或抛错 */
  function fakeRag(script: () => RagChunk[] | Error): RagClient & { queries: RagQuery[] } {
    const queries: RagQuery[] = []
    return {
      queries,
      async retrieve(query: RagQuery) {
        queries.push(query)
        const result = script()
        if (result instanceof Error) throw result
        return result
      },
      onCall() {},
    }
  }

  const CHUNKS: RagChunk[] = [
    { content: '报 500 先查网关日志确认上游超时', score: 0.92, source: 'ts.md' },
    { content: '低相关片段会被阈值过滤', score: 0.2, source: 'noise.md' },
  ]

  function skill(overrides: Partial<WelinkSkill> = {}): WelinkSkill {
    return {
      id: 'fault-fix',
      name: '故障咨询',
      description: '系统报错类问题',
      enabled: true,
      keywords: ['500'],
      promptTemplate: '故障技能模板 {{retrieved}} {{question}}',
      knowledge: '',
      reviewMode: 'auto',
      retrieval: { enabled: true },
      knowledgeDocs: [],
      ...overrides,
    }
  }

  it('检索命中：片段经阈值过滤拼装进 prompt（带来源与相关度头）', async () => {
    const rag = fakeRag(() => CHUNKS)
    const h = harness({
      jobs: [job()],
      settings: { agent: { ...DEFAULT_WELINK_SETTINGS.agent, skills: [skill()] } },
      rag: () => rag,
      sendImpl: async () => ({ msgUid: 'u1' }),
    })
    h.pipeline.start()
    h.pipeline.enqueue(1)
    await h.pipeline.drain()
    // query = 触发消息内容；低分片段被 minScore=0 之外的阈值滤掉需显式配置，默认 0 不过滤
    expect(rag.queries).toHaveLength(1)
    expect(rag.queries[0].query).toContain('报 500')
    expect(h.agent.calls[0]).toContain('【知识1】(来源 ts.md, 相关度 0.92)')
    expect(h.agent.calls[0]).toContain('报 500 先查网关日志')
    expect(h.agent.calls[0]).toContain('低相关片段会被阈值过滤')
  })

  it('minScore 过滤低分片段；maxChars 截断注入总量', async () => {
    const rag = fakeRag(() => CHUNKS)
    const h = harness({
      jobs: [job()],
      settings: {
        agent: { ...DEFAULT_WELINK_SETTINGS.agent, skills: [skill()] },
        rag: { ...DEFAULT_WELINK_SETTINGS.rag, minScore: 0.5, maxChars: 200 },
      },
      rag: () => rag,
      sendImpl: async () => ({ msgUid: 'u1' }),
    })
    h.pipeline.start()
    h.pipeline.enqueue(1)
    await h.pipeline.drain()
    const prompt = h.agent.calls[0]
    expect(prompt).toContain('【知识1】')
    expect(prompt).not.toContain('低相关片段')
    expect(prompt.length).toBeLessThan(200 + 600) // 截断后 prompt 不会无限膨胀
  })

  it('检索失败：空串降级、生成继续（草稿照常落库外发）', async () => {
    const rag = fakeRag(() => new Error('RAG 服务不可用'))
    const h = harness({
      jobs: [job()],
      settings: { agent: { ...DEFAULT_WELINK_SETTINGS.agent, skills: [skill()] } },
      rag: () => rag,
      sendImpl: async () => ({ msgUid: 'u1' }),
    })
    h.pipeline.start()
    h.pipeline.enqueue(1)
    await h.pipeline.drain()
    expect(h.agent.calls[0]).not.toContain('【知识1】')
    expect(h.agent.calls[0]).toContain('故障技能模板') // 生成未被阻断
    expect(jobOf(h, 1).status).toBe('sent')
  })

  it('技能未启用检索：不发起检索调用（老配置零迁移语义）', async () => {
    const rag = fakeRag(() => CHUNKS)
    const h = harness({
      jobs: [job()],
      settings: { agent: { ...DEFAULT_WELINK_SETTINGS.agent, skills: [skill({ retrieval: { enabled: false } })] } },
      rag: () => rag,
      sendImpl: async () => ({ msgUid: 'u1' }),
    })
    h.pipeline.start()
    h.pipeline.enqueue(1)
    await h.pipeline.drain()
    expect(rag.queries).toHaveLength(0)
    expect(jobOf(h, 1).status).toBe('sent')
  })

  it('兜底技能检索由 rag.fallbackRetrieve 全局开关控制（D8）', async () => {
    const rag = fakeRag(() => CHUNKS)
    // 关：未命中技能 → 兜底 → 不检索
    const h1 = harness({
      jobs: [job()],
      settings: { rag: { ...DEFAULT_WELINK_SETTINGS.rag, fallbackRetrieve: false } },
      rag: () => rag,
      sendImpl: async () => ({ msgUid: 'u1' }),
    })
    h1.pipeline.start()
    h1.pipeline.enqueue(1)
    await h1.pipeline.drain()
    expect(rag.queries).toHaveLength(0)
    // 开：兜底也检索
    const h2 = harness({
      jobs: [job({ pk: 2 })],
      settings: { rag: { ...DEFAULT_WELINK_SETTINGS.rag, fallbackRetrieve: true } },
      rag: () => rag,
      sendImpl: async () => ({ msgUid: 'u2' }),
    })
    h2.pipeline.start()
    h2.pipeline.enqueue(2)
    await h2.pipeline.drain()
    expect(rag.queries).toHaveLength(1)
    expect(h2.agent.calls[0]).not.toContain('【知识1】') // 默认兜底模板不含 {{retrieved}} → 已发起检索但不注入（D-D）
  })

  it('未装配 rag（options.rag 缺省）：即便技能启用检索也零开销跳过', async () => {
    const h = harness({
      jobs: [job()],
      settings: { agent: { ...DEFAULT_WELINK_SETTINGS.agent, skills: [skill()] } },
      sendImpl: async () => ({ msgUid: 'u1' }),
    })
    h.pipeline.start()
    h.pipeline.enqueue(1)
    await h.pipeline.drain()
    expect(h.agent.calls[0]).not.toContain('【知识1】')
    expect(jobOf(h, 1).status).toBe('sent')
  })
})

describe('orchestrator/pipeline —— RAG 工厂 getter 热更新（rag-retrieval P1-1）', () => {
  function skill(overrides: Partial<WelinkSkill> = {}): WelinkSkill {
    return {
      id: 'fault-fix',
      name: '故障咨询',
      description: '系统报错类问题',
      enabled: true,
      keywords: ['500'],
      promptTemplate: '故障技能模板 {{retrieved}} {{question}}',
      knowledge: '',
      reviewMode: 'auto',
      retrieval: { enabled: true },
      knowledgeDocs: [],
      ...overrides,
    }
  }

  function fakeRag(tag: string): RagClient & { queries: RagQuery[] } {
    const queries: RagQuery[] = []
    return {
      queries,
      async retrieve(query: RagQuery) {
        queries.push(query)
        return [{ content: `${tag} 片段`, score: 0.9, source: `${tag}.md` }]
      },
      onCall() {},
    }
  }

  it('配置变更（getter 返回新实例）后下一次检索自动取新实例，无需重启管线', async () => {
    const ragA = fakeRag('旧实例')
    const ragB = fakeRag('新实例')
    let useB = false
    const h = harness({
      jobs: [job(), job({ pk: 2 })],
      settings: { agent: { ...DEFAULT_WELINK_SETTINGS.agent, skills: [skill()] } },
      // 真实链路里这是 ragClient 工厂 getter：缓存键含连接配置，配置变更即出新实例
      rag: () => (useB ? ragB : ragA),
      sendImpl: async () => ({ msgUid: 'u1' }),
    })
    h.pipeline.start()
    h.pipeline.enqueue(1)
    await h.pipeline.drain()
    expect(ragA.queries).toHaveLength(1)
    expect(h.agent.calls[0]).toContain('旧实例 片段')

    useB = true // 模拟 reload 换了连接配置
    h.pipeline.enqueue(2)
    await h.pipeline.drain()
    expect(ragB.queries).toHaveLength(1)
    expect(ragA.queries).toHaveLength(1) // 旧实例不再被调用
    expect(h.agent.calls[1]).toContain('新实例 片段')
  })
})

// ---------------------------------------------------------------- 本地知识文档注入（knowledge-sedimentation 5.2）

describe('orchestrator/pipeline —— 本地知识文档注入（{{docs}}，knowledge-sedimentation）', () => {
  beforeEach(() => {
    resetMockKnowledge()
  })

  function skill(overrides: Partial<WelinkSkill> = {}): WelinkSkill {
    return {
      id: 'fault-fix',
      name: '故障咨询',
      description: '系统报错类问题',
      enabled: true,
      keywords: ['500'],
      promptTemplate: 'Q:{{question}}',
      knowledge: '',
      reviewMode: 'auto',
      retrieval: { enabled: false },
      knowledgeDocs: [],
      ...overrides,
    }
  }

  function knowledgeWith(): KnowledgePort {
    seedMockKnowledgeFile('knowledge/door.md', '门禁卡找行政前台办理，需携带工牌。')
    return createMockKnowledgePort()
  }

  it('命中技能加载绑定文档：内容经【文档·标题】头注入 {{docs}}，超出上限截断', async () => {
    seedMockKnowledgeFile(
      'knowledge/index.json',
      JSON.stringify({ docs: [{ file: 'door.md', title: '门禁手册', updatedAt: '2026-10-06 10:00:00', source: 'manual' }] }),
    )
    const h = harness({
      jobs: [job()],
      settings: {
        sediment: { enabled: false, mode: 'manual', sessions: [], intervalHours: 6, qaArchive: false, docsMaxChars: 50 },
        agent: {
          ...DEFAULT_WELINK_SETTINGS.agent,
          skills: [
            skill({
              keywords: ['500'],
              promptTemplate: '参考：{{docs}}\nQ:{{question}}',
              knowledgeDocs: ['door.md'],
            }),
          ],
        },
      },
      knowledge: knowledgeWith,
    })
    h.pipeline.start()
    h.pipeline.enqueue(1)
    await h.pipeline.drain()
    expect(h.agent.calls[0]).toContain('【文档·门禁手册】')
    // docsMaxChars=50：注入总长被截断并带省略号
    expect(h.agent.calls[0].length).toBeLessThan(200)
  })

  it('文件丢失静默降级：空注入继续生成，不重试不失败', async () => {
    seedMockKnowledgeFile(
      'knowledge/index.json',
      JSON.stringify({ docs: [{ file: 'gone.md', title: '已丢失', updatedAt: '2026-10-06 10:00:00', source: 'manual' }] }),
    )
    const h = harness({
      jobs: [job()],
      settings: {
        agent: {
          ...DEFAULT_WELINK_SETTINGS.agent,
          skills: [skill({ keywords: ['500'], promptTemplate: '参考：[{{docs}}]\nQ:{{question}}', knowledgeDocs: ['gone.md'] })],
        },
      },
      knowledge: knowledgeWith,
    })
    h.pipeline.start()
    h.pipeline.enqueue(1)
    await h.pipeline.drain()
    expect(h.agent.calls[0]).toContain('参考：[]')
    expect(jobOf(h, 1).status).toBe('sent')
  })

  it('未绑定/模板无占位符零开销：不读取任何文件，行为与升级前一致', async () => {
    seedMockKnowledgeFile('knowledge/door.md', '不该被读取的正文')
    seedMockKnowledgeFile(
      'knowledge/index.json',
      JSON.stringify({ docs: [{ file: 'door.md', title: '门禁手册', updatedAt: '2026-10-06 10:00:00', source: 'manual' }] }),
    )
    let reads = 0
    const countingPort: KnowledgePort = {
      async listDocs() {
        reads += 1
        return (await knowledgeWith()).listDocs()
      },
      async readDoc(file) {
        reads += 1
        return seedContent(file)
      },
      async saveDoc() {
        throw new Error('不应写入')
      },
      async appendDoc() {
        throw new Error('不应写入')
      },
      async offShelf() {
        return false
      },
      async registerDoc() {
        throw new Error('不应写入')
      },
      async resolveDocs(files) {
        reads += 1
        return files.length ? [{ file: 'door.md', title: '门禁手册', updatedAt: '', source: 'manual' as const }] : []
      },
    }
    function seedContent(file: string) {
      return file === 'door.md' ? '不该被读取的正文' : null
    }

    // 技能已绑定但模板无 {{docs}} → 零读取
    const h1 = harness({
      jobs: [job()],
      settings: {
        agent: {
          ...DEFAULT_WELINK_SETTINGS.agent,
          skills: [skill({ keywords: ['500'], promptTemplate: 'Q:{{question}}', knowledgeDocs: ['door.md'] })],
        },
      },
      knowledge: () => countingPort,
    })
    h1.pipeline.start()
    h1.pipeline.enqueue(1)
    await h1.pipeline.drain()
    expect(h1.agent.calls[0]).not.toContain('不该被读取的正文')

    // 模板有 {{docs}} 但未绑定 → 零读取
    const h2 = harness({
      jobs: [job()],
      settings: {
        agent: {
          ...DEFAULT_WELINK_SETTINGS.agent,
          skills: [skill({ keywords: ['500'], promptTemplate: '参考：[{{docs}}]\nQ:{{question}}' })],
        },
      },
      knowledge: () => countingPort,
    })
    h2.pipeline.start()
    h2.pipeline.enqueue(1)
    await h2.pipeline.drain()
    expect(h2.agent.calls[0]).toContain('参考：[]')
    expect(reads).toBe(0)
  })
})
