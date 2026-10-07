import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * M3 全链路集成测试（设计 §12 M3 验收：「假时钟全链路：mock→库→mock agent→Gate→mock send」）。
 *
 * 与 `pipeline.spec.ts` / `poller.spec.ts` 的分工：
 *  * 那两个文件用**假仓储**测各自的单元语义（断言 SQL 调用、参数绑定）；
 *  * 这里**不替换仓储**（用真实的内存实现）也不替换 Gate，只把「外部世界」
 *    （welink 端口、Agent）换成可控的 mock，从而验证**部件之间的接线是否正确**。
 *
 * 为什么必须有这一层：本次开发中真实存在的两类缺陷都只在「接线」上暴露，
 * 单件测试全绿也发现不了 ——
 *  1. `runtime.ts` 没把 `jobCreated` 事件接到 `pipeline.enqueue` → 新任务永远停在
 *     `pending`，端到端自动回复**彻底不通**；
 *  2. `pipeline` 调 `gate.onSent(targetId, '')` 传空 senderId → S5 同人短窗合并
 *     永不生效（`getMessage` 反查链路整条是死的）。
 *
 * 这两条都属于「每个部件单独看都对、拼起来不对」，只有端到端跑一遍才会红。
 */
import { createWelinkRuntime, type WelinkRuntime } from '@/orchestrator/runtime'
import type { WelinkEvent } from '@/orchestrator/events'
import { RETENTION_FIRST_DELAY_MS, RETENTION_INTERVAL_MS } from '@/orchestrator/retention'
import type { TimerApi } from '@/orchestrator/timers'
import { memoryWelinkRepository, resetWelinkMemory } from '@/infra/db/repos/welink-memory'
import type { WelinkPort } from '@/infra/welink'
import type { PullResult } from '@/infra/welink/port'
import type { AgentCallRecord, AgentClient } from '@/infra/agent'
import {
  DEFAULT_WELINK_SETTINGS,
  normalizeWelinkSettings,
  type NormalizedMessage,
  type WelinkSettings,
} from '@/types/welink'

// ---------------------------------------------------------------- 假时钟

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

/** 让 await 链跑干净（真实微任务队列） */
async function settle(rounds = 30) {
  for (let index = 0; index < rounds; index += 1) await Promise.resolve()
}

// ---------------------------------------------------------------- 假端口 / 假 Agent

const storage = new Map<string, string>()
vi.stubGlobal('localStorage', {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => void storage.set(key, value),
  removeItem: (key: string) => void storage.delete(key),
  clear: () => storage.clear(),
})

interface FakePortHarness {
  port: WelinkPort
  sent: Array<{ convId: string; text: string }>
  /** 按会话预置一批消息；同一会话多次调用按批返回并置 hasMore=false */
  push(convId: string, items: Array<Partial<NormalizedMessage>>): void
  /** 仅下一次 send 失败（之后的 send 正常） */
  failNextSend(message: string): void
  /** 之后所有 send 都失败（测重试耗尽用） */
  failAlwaysSend(message: string): void
}

function createFakePort(): FakePortHarness {
  const batches = new Map<string, NormalizedMessage[][]>()
  const sent: Array<{ convId: string; text: string }> = []
  let oneShotFailure: string | null = null
  let persistentFailure: string | null = null
  let uid = 0

  const port: WelinkPort = {
    async listConversations() {
      return []
    },
    async pull(conv, after): Promise<PullResult> {
      const queue = batches.get(conv.convId) ?? []
      const batch = queue.shift() ?? []
      batches.set(conv.convId, queue)
      return {
        messages: batch.map((item) => ({ ...item, convId: conv.convId, convType: conv.convType })),
        // cursor 对业务不透明（端口契约），这里给个稳定可比的串
        cursor: `${conv.convId}:${after}:${batch.length}`,
        hasMore: queue.length > 0,
      }
    },
    async send(target, text) {
      if (persistentFailure) throw new Error(persistentFailure)
      if (oneShotFailure) {
        const reason = oneShotFailure
        oneShotFailure = null
        throw new Error(reason)
      }
      sent.push({ convId: target.convId, text })
      uid += 1
      return { msgUid: `sent-${uid}` }
    },
  }

  return {
    port,
    sent,
    push(convId, items) {
      const queue = batches.get(convId) ?? []
      queue.push(
        items.map((item, index) => ({
          msgUid: item.msgUid ?? `${convId}-uid-${index + 1}`,
          convType: 'group',
          convId,
          direction: 'in',
          senderId: 'E-9001',
          senderName: '赵敏',
          content: '@我 看下接口报 500',
          msgType: 'text',
          atMe: true,
          sentAt: `2026-09-27 14:0${index}:00`,
          ...item,
        })),
      )
      batches.set(convId, queue)
    },
    failNextSend(message) {
      oneShotFailure = message
    },
    failAlwaysSend(message) {
      persistentFailure = message
    },
  }
}

interface FakeAgentHarness {
  agent: AgentClient
  calls: string[]
  emit: (record: Partial<AgentCallRecord>) => void
  failNext(message: string): void
}

function createFakeAgent(reply = '收到，我看一下'): FakeAgentHarness {
  const calls: string[] = []
  const handlers: Array<(record: AgentCallRecord) => void> = []
  let failure: string | null = null

  /** 真实客户端在每次 complete 结束后回调 `onCall`（成功与失败都回调，R4 的 1:N 留痕） */
  const record = (prompt: string, response: string, status: 'ok' | 'error', error: string) => {
    const payload: AgentCallRecord = { prompt, response, status, latencyMs: 12, error }
    for (const handler of handlers) handler(payload)
  }

  return {
    calls,
    emit(record_) {
      for (const handler of handlers) {
        handler({
          prompt: '',
          response: '',
          status: 'ok',
          latencyMs: 12,
          error: '',
          ...record_,
        } as AgentCallRecord)
      }
    },
    failNext(message) {
      failure = message
    },
    agent: {
      async complete(prompt: string) {
        calls.push(prompt)
        if (failure) {
          const reason = failure
          failure = null
          record(prompt, '', 'error', reason)
          throw new Error(reason)
        }
        record(prompt, reply, 'ok', '')
        return reply
      },
      onCall(handler: (record: AgentCallRecord) => void) {
        handlers.push(handler)
      },
    } as unknown as AgentClient,
  }
}

// ---------------------------------------------------------------- 装配

interface Harness {
  runtime: WelinkRuntime
  port: FakePortHarness
  agent: FakeAgentHarness
  events: WelinkEvent[]
  scheduler: ReturnType<typeof createScheduler>
  settings: WelinkSettings
  statusOf(jobPk: number): Promise<string>
}

async function harness(overrides: Partial<WelinkSettings> = {}): Promise<Harness> {
  resetWelinkMemory()
  storage.clear()

  const port = createFakePort()
  const agent = createFakeAgent()
  const scheduler = createScheduler()
  const events: WelinkEvent[] = []

  const settings = normalizeWelinkSettings({
    ...DEFAULT_WELINK_SETTINGS,
    ...overrides,
    // 默认开总开关（多数用例跑的是「助手在跑」的场景）；
    // 想测关闭态必须显式传 enabled:false —— 这里**不能**无条件写 true，
    // 否则 overrides 里的 enabled 被静默吞掉（曾让「总开关关闭时不起清理」用例假通过）。
    enabled: overrides.enabled ?? true,
    myUserId: 'E-0001',
    sendMode: 'auto',
    // 关掉频控干扰：本测试关心链路是否通，不关心限流（限流另有 safety-gate.spec）
    safety: {
      ...DEFAULT_WELINK_SETTINGS.safety,
      perConvMinIntervalSec: 0,
      mergeWindowSec: 0,
      quietHours: { enabled: false, from: '22:00', to: '08:00' },
      fuseThreshold: 99,
      ...overrides.safety,
    },
  } as WelinkSettings)

  const runtime = createWelinkRuntime({
    settings: () => settings,
    emit: (event) => events.push(event),
    repo: memoryWelinkRepository,
    port: () => port.port,
    agent: agent.agent,
    timers: scheduler.timers,
    // 与 settings.enabled 同源：否则 bootstrap 认为「没在跑」而 runtime 认为「在跑」，
    // 清理器/轮询的起停判据会分裂（enabled:false 的用例必须两边都不启动）
    autoStart: overrides.enabled ?? true,
    staggerMs: 0,
    // 保留期清理挂进同一套假时钟：不真等 10s / 一天，也不让测试的 queued 计数被它污染
    retention: { firstDelayMs: RETENTION_FIRST_DELAY_MS, intervalMs: RETENTION_INTERVAL_MS },
  })

  // 建立监控会话（watching + autoReply）—— 生产环境由用户配置，这里直接铺数据
  await memoryWelinkRepository.upsertConversation({
    convType: 'group',
    convId: 'G-1001',
    title: '研发一组',
    watching: true,
    autoReply: true,
  })
  await memoryWelinkRepository.updateConversation('G-1001', { autoReply: true })
  runtime.gate.cacheConversation('G-1001', true, null)

  return {
    runtime,
    port,
    agent,
    events,
    scheduler,
    settings,
    async statusOf(jobPk) {
      const job = await memoryWelinkRepository.getJob(jobPk)
      return job ? job.status : 'missing'
    },
  }
}

beforeEach(() => {
  resetWelinkMemory()
  storage.clear()
})

// ---------------------------------------------------------------- 用例

describe('M3 全链路：mock 端口 → 内存库 → mock Agent → SafetyGate → mock send', () => {
  it('端到端自动回复：@我 消息被拉到后自动生成草稿并外发（P0 事件接线的回归闸）', async () => {
    const h = await harness()
    h.port.push('G-1001', [{ content: '@我 线上接口 500 了，帮忙看下' }])

    h.runtime.pipeline.start()
    const summary = await h.runtime.pullNow()
    expect(summary.conversations).toBe(1)

    // 关键断言：新 job 必须**自动**进入管线 —— 没有这步，后端不会自己动
    await h.runtime.pipeline.drain()
    await settle()

    expect(h.agent.calls).toHaveLength(1)
    expect(h.agent.calls[0]).toContain('线上接口 500')
    expect(h.port.sent).toHaveLength(1)
    expect(h.port.sent[0]).toMatchObject({ convId: 'G-1001', text: '收到，我看一下' })

    const job = (await memoryWelinkRepository.listJobs({ limit: 10, offset: 0 }))[0]
    expect(job.status).toBe('sent')
    expect(job.draft).toBe('收到，我看一下')
  })

  it('M3 全链路（rag）：启用检索的技能命中 mock 语料，片段注入生成 prompt（rag 装配回归闸）', async () => {
    const h = await harness({
      agent: {
        ...DEFAULT_WELINK_SETTINGS.agent,
        skills: [
          {
            id: 'fault-fix',
            name: '故障咨询',
            description: '系统报错类问题',
            enabled: true,
            keywords: ['500'],
            promptTemplate: '故障模板 {{retrieved}} {{question}}',
            knowledge: '',
            reviewMode: 'auto',
            retrieval: { enabled: true },
            knowledgeDocs: [],
          },
        ],
      },
    })
    h.port.push('G-1001', [{ content: '@我 线上接口 500 了，帮忙看下' }])

    h.runtime.pipeline.start()
    await h.runtime.pullNow()
    await h.runtime.pipeline.drain()
    await settle()

    // rag 实例由 runtime 经 ragClient 工厂装配（测试环境 → mock 语料，'500' 键命中）
    expect(h.agent.calls[0]).toContain('【知识1】')
    expect(h.agent.calls[0]).toContain('接口返回 500 时先查网关日志')
    expect(h.port.sent).toHaveLength(1)
  })

  it('Agent 留痕归属到正确的 job（R4：onCall 1:N 语料不能张冠李戴）', async () => {
    const h = await harness()
    h.port.push('G-1001', [{ content: '@我 帮忙看下' }])

    h.runtime.pipeline.start()
    await h.runtime.pullNow()
    await h.runtime.pipeline.drain()
    await settle()

    const jobs = await memoryWelinkRepository.listJobsWithLogs(10, 0, false)
    expect(jobs).toHaveLength(1)
    const logs = await memoryWelinkRepository.listAgentLogs(jobs[0].pk)
    expect(logs).toHaveLength(1)
    expect(logs[0].status).toBe('ok')
    expect(logs[0].prompt).toContain('帮忙看下')
  })

  it('外发持续失败 → 重试耗尽落 failed（不吞错、不放行未发成功的回复）', async () => {
    const h = await harness()
    h.port.push('G-1001', [{ content: '@我 触发一次发送失败' }])
    h.port.failAlwaysSend('mock：welink-cli 退出码 1')

    h.runtime.pipeline.start()
    await h.runtime.pullNow()
    await h.runtime.pipeline.drain()
    await settle()

    expect(h.port.sent).toHaveLength(0)
    const job = (await memoryWelinkRepository.listJobs({ limit: 10, offset: 0 }))[0]
    expect(job.status).toBe('failed')
    expect(job.attempts).toBe(3)
    expect(job.lastError).toContain('退出码 1')
  })

  it('S5 同人短窗合并：同一人连发两条 @我 只生成一次回复，但上下文含两条', async () => {
    const h = await harness({
      safety: { ...DEFAULT_WELINK_SETTINGS.safety, mergeWindowSec: 300, perConvMinIntervalSec: 0 },
    })
    h.port.push('G-1001', [
      { msgUid: 'u1', content: '@我 第一个问题', sentAt: '2026-09-27 14:00:00' },
      { msgUid: 'u2', content: '@我 第二个问题', sentAt: '2026-09-27 14:00:10' },
    ])

    h.runtime.pipeline.start()
    await h.runtime.pullNow()
    await h.runtime.pipeline.drain()
    await settle()

    const jobs = await memoryWelinkRepository.listJobs({ limit: 10, offset: 0 })
    // S5 在建任务阶段收敛：同一人短窗内只留一条任务
    expect(jobs).toHaveLength(1)
    // 但上下文里两条触发都要在（否则回复会漏掉第二个问题）。
    // 注意 recentContext 是**按会话**取，不是按 job —— 所以回复气泡也在其中，
    // 这里只断言「两条触发都在、且都在回复之前」。
    const context = await memoryWelinkRepository.recentContext(1, 10)
    const contents = context.map((row) => row.content)
    expect(contents).toContain('@我 第一个问题')
    expect(contents).toContain('@我 第二个问题')
    expect(contents.indexOf('@我 第一个问题')).toBeLessThan(contents.indexOf('收到，我看一下'))
  })

  it('S5 外发记账：gate.onSent 拿到真实 senderId（空串会让合并基线永远为空）', async () => {
    const h = await harness()
    h.port.push('G-1001', [{ content: '@我 需要回复' }])

    const onSent = vi.spyOn(h.runtime.gate, 'onSent')

    h.runtime.pipeline.start()
    await h.runtime.pullNow()
    await h.runtime.pipeline.drain()
    await settle()

    expect(onSent).toHaveBeenCalledWith('G-1001', 'E-9001')
  })

  it('启动恢复：sending 无回执 → 回落 ready 并重新入队（§6.3 三分支之「没发出去」）', async () => {
    const h = await harness()
    h.port.push('G-1001', [{ content: '@我 崩溃前没发完的任务' }])
    // 让外发一直失败：这样库里**没有 out 消息**，正好构造「无回执」的前提
    h.port.failAlwaysSend('mock：发送中断')

    h.runtime.pipeline.start()
    await h.runtime.pullNow()
    await h.runtime.pipeline.drain()
    await settle()

    const job = (await memoryWelinkRepository.listJobs({ limit: 10, offset: 0 }))[0]
    expect(h.port.sent).toHaveLength(0)
    // 人为把它打回 sending（模拟「进程在发送中途被杀」，且没有留下 out 回执）
    await memoryWelinkRepository.markStatus(job.pk, 'sending', 'failed')

    const report = await h.runtime.bootstrap.run()
    expect(report.requeued).toBe(1)
    expect(report.recoveredSent).toBe(0)
    expect(await h.statusOf(job.pk)).toBe('ready')
  })

  it('启动恢复：sending 有回执 → 补记 sent（绝不重发，否则群里两条一样的）', async () => {
    const h = await harness()
    h.port.push('G-1001', [{ content: '@我 发出去了但没记上' }])

    h.runtime.pipeline.start()
    await h.runtime.pullNow()
    await h.runtime.pipeline.drain()
    await settle()

    const job = (await memoryWelinkRepository.listJobs({ limit: 10, offset: 0 }))[0]
    // 造出「已有 out 回执，但 job 停在 sending」的崩溃窗口。
    // 内存库的 hasOutgoingReceipt 口径 = 「该会话存在 direction=out 且 content == job.draft」，
    // 因此仅把 job 打回 sending，即可复用刚刚那条已发出的 out 消息作为回执。
    await memoryWelinkRepository.markStatus(job.pk, 'sending', 'sent')

    const report = await h.runtime.bootstrap.run()

    expect(report.recoveredSent).toBe(1)
    expect(report.requeued).toBe(0)
    expect(await h.statusOf(job.pk)).toBe('sent')
  })

  it('熔断触发时向外发出 fuseTripped 事件（S8，控制条横幅的唯一数据源）', async () => {
    // 确定性熔断构造（评审 T-3：原用例断言 `every` 于可能为空的数组，恒真——
    // 漏注册 onFuse 也绿）。配额拦截计入熔断（FUSE_REASONS）且命中数**超过**
    // 阈值才熔断（safety-gate registerSkip），因此：cap=1 + threshold=1 时，
    // 第 1 个 job 正常发出（配额扣到 1），第 2 个被 S2 拦（hit #1，未到），
    // 第 3 个再被拦（hit #2 > 1）→ 熔断。三个不同发送者避免 S5 合并干扰。
    const h = await harness({
      safety: {
        ...DEFAULT_WELINK_SETTINGS.safety,
        // 显式关掉 S1/S5：harness 默认值会被本覆盖对象的 DEFAULT 展开顶掉，
        // 不写回去熔断会被 S1 最小间隔抢先触发（实测 reason 变成 rate_conv）
        perConvMinIntervalSec: 0,
        mergeWindowSec: 0,
        perConvHourlyCap: 1,
        fuseThreshold: 1,
        fuseWindowMin: 10,
      },
    })
    h.port.push('G-1001', [
      { msgUid: 'f1', senderId: 'E-9001', content: '@我 第一条正常发出', sentAt: '2026-09-27 14:00:00' },
      { msgUid: 'f2', senderId: 'E-9002', content: '@我 第二条触发配额拦截', sentAt: '2026-09-27 14:00:01' },
      { msgUid: 'f3', senderId: 'E-9003', content: '@我 第三条越过熔断阈值', sentAt: '2026-09-27 14:00:02' },
    ])

    h.runtime.pipeline.start()
    await h.runtime.pullNow()
    await h.runtime.pipeline.drain()
    await settle()

    // 组合根必须把 gate.onFuse 接到 emit —— 漏注册时这里立刻变红
    const fuseEvents = h.events.filter((event) => event.type === 'fuseTripped')
    expect(fuseEvents.length).toBeGreaterThanOrEqual(1)
    const first = fuseEvents[0] as { scope: string; reason: string }
    expect(first.scope).toBe('group_at_me')
    expect(first.reason).toBe('rate_conv_hourly')
  })

  it('总开关 OFF 时恢复数据但不启动调度（autoStart=false：不轮询、不外发）', async () => {
    const h = await harness({ enabled: false })
    h.port.push('G-1001', [{ content: '@我 不该被处理' }])

    const report = await h.runtime.start()
    expect(report.watching).toBe(1)
    expect(h.runtime.running()).toBe(false)

    await h.runtime.pipeline.drain()
    await settle()
    expect(h.port.sent).toHaveLength(0)
    expect(h.agent.calls).toHaveLength(0)
  })

  it('停用后不再外发（stop 先断生产再断消费）', async () => {
    const h = await harness()
    h.runtime.pipeline.start()
    h.runtime.poller.start()
    h.runtime.stop()
    expect(h.runtime.running()).toBe(false)
    expect(h.runtime.pipeline.running()).toBe(false)
    expect(h.runtime.poller.running()).toBe(false)
  })

  it('助手启动后保留期清理随之启动，停止后随之停止（D-1：清理不能只定义不调度）', async () => {
    const h = await harness()

    // 未启动时清理器不该在跑（避免「关了助手还在后台改数据」）
    expect(h.runtime.retention.running()).toBe(false)

    await h.runtime.start()
    expect(h.runtime.retention.running()).toBe(true)

    // 每日一次的间隔必须是 24h（不是「每轮轮询顺手删一遍」那种高频动作）
    expect(RETENTION_INTERVAL_MS).toBe(24 * 60 * 60 * 1000)
    // 首轮延迟正数：不抢冷启动的迁移/恢复
    expect(RETENTION_FIRST_DELAY_MS).toBeGreaterThan(0)

    h.runtime.stop()
    expect(h.runtime.retention.running()).toBe(false)
  })

  it('总开关关闭时不起清理（用户没在采集数据，后台不该动库）', async () => {
    const h = await harness({ enabled: false })
    await h.runtime.start()
    expect(h.runtime.retention.running()).toBe(false)
  })

  it('purgeNow 暴露给 UI：与每日自动轮次共用 single-flight（连点不会并发删）', async () => {
    const h = await harness()
    const [a, b] = await Promise.all([h.runtime.purgeNow(), h.runtime.purgeNow()])
    // 空库下两批都是 0，重点是两次调用指向同一次执行结果
    expect(a).toEqual(b)
    expect(a.messages).toBe(0)
    expect(a.agentLogs).toBe(0)
  })
})

// ---------------------------------------------------------------- 知识沉淀装配（4.4）

describe('知识沉淀装配：调度随 runtime 起停，提取独立于回复链路', () => {
  const sedimentSettings = {
    enabled: true,
    mode: 'manual' as const,
    sessions: ['G-1001'],
    intervalHours: 1,
    qaArchive: false,
    docsMaxChars: 3000,
  }

  it('助手启动后沉淀调度随之启动：到点执行一轮提取（agent 收到提取提示词）', async () => {
    const h = await harness({ sediment: sedimentSettings })
    await h.runtime.start()
    // 铺一条普通群消息（不带 @我：不触发回复任务，只有沉淀消费）
    h.port.push('G-1001', [{ content: '门禁卡怎么办理？', atMe: false }])
    await h.runtime.pullNow()
    const replyCalls = h.agent.calls.length
    expect(h.agent.calls.every((prompt) => !prompt.includes('候选材料'))).toBe(true)

    h.scheduler.advance(3_600_000)
    await settle()
    const extractCalls = h.agent.calls.filter((prompt) => prompt.includes('候选材料'))
    expect(extractCalls).toHaveLength(1)
    expect(extractCalls[0]).toContain('门禁卡怎么办理？')
    expect(h.agent.calls.length).toBeGreaterThan(replyCalls) // 提取调用是新增的一条
  })

  it('runtime.stop 后沉淀调度停止；runOnce（立即提取）仍可手动触发', async () => {
    const h = await harness({ sediment: sedimentSettings })
    await h.runtime.start()
    h.runtime.stop()
    h.scheduler.advance(3_600_000)
    await settle()
    expect(h.agent.calls.filter((prompt) => prompt.includes('候选材料'))).toHaveLength(0)

    const report = await h.runtime.harvester.runOnce()
    expect(report.skipped).toBeNull() // 手动入口不受调度停止影响
  })

  it('沉淀开关关闭时轮次自检跳过（skipped=disabled），不产生模型调用（沉淀与助手总开关相互独立）', async () => {
    const h = await harness({ enabled: false, sediment: { ...sedimentSettings, enabled: false } })
    const report = await h.runtime.harvester.runOnce()
    expect(report.skipped).toBe('disabled')
    expect(h.agent.calls.filter((prompt) => prompt.includes('候选材料'))).toHaveLength(0)
  })
})
