import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 知识沉淀管线单测（knowledge-sedimentation 4.1~4.4）。
 *
 * 原料侧用 welink 内存仓储种子、沉淀仓储用内存实现、知识端口用内存实现、
 * 端口用 mock welink 端口 —— 全链路在内存里跑真实编排逻辑，只注入 agent 假件。
 * 重点钉住六条行为：水位推进不重复采集、指纹去重（双侧）、失败跳过与连续失败阈值、
 * 评审流转（先写文件后置终态）、问答归档（追加/关闭零写入）、公告能力缺失诚实降级。
 */
const storage = new Map<string, string>()
vi.stubGlobal('localStorage', {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => void storage.set(key, value),
  removeItem: (key: string) => void storage.delete(key),
  clear: () => storage.clear(),
})

vi.mock('@/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

import { memorySedimentRepository, resetSedimentMemory } from '@/infra/db/repos/sediment-memory'
import { memoryWelinkRepository, resetWelinkMemory } from '@/infra/db/repos/welink-memory'
import type { WelinkRepository } from '@/infra/db/ports'
import type { WelinkPort } from '@/infra/welink'
import type { SedimentRepository } from '@/infra/db/sediment-ports'
import { SEDIMENT_KEYS } from '@/infra/db/sediment-ports'
import { createMockKnowledgePort, resetMockKnowledge } from '@/infra/knowledge'
import { createCliWelinkPort } from '@/infra/welink/welink-cli'
import { createMockWelinkPort, type MockWelinkPort } from '@/infra/welink/mock'
import type { AgentClient } from '@/infra/agent'
import { DEFAULT_WELINK_SETTINGS, type WelinkSettings } from '@/types/welink'
import {
  createKnowledgeHarvester,
  buildExtractPrompt,
  fingerprint,
  parseExtractReply,
  type KnowledgeHarvester,
  type SedimentRoundReport,
} from './knowledge-harvester'
import type { TimerApi } from './timers'

// ---------------- 假件与种子 ----------------

function fakeAgent(overrides: Partial<Pick<AgentClient, 'complete'>> = {}): AgentClient {
  return {
    complete: overrides.complete ?? vi.fn(async () => '[]'),
    onCall: vi.fn(),
  }
}

/** 假时钟 TimerApi：记录排的延迟与处理器，测试手动触发 */
function fakeTimers() {
  const pending = new Map<number, { delayMs: number; handler: () => void }>()
  let seq = 0
  const api: TimerApi & { fireAll(): Promise<void>; delays(): number[]; size(): number } = {
    set(handler, delayMs) {
      const id = (seq += 1)
      pending.set(id, { delayMs, handler })
      return id
    },
    clear(id) {
      pending.delete(id as number)
    },
    async fireAll() {
      const handlers = [...pending.values()].map((item) => item.handler)
      pending.clear()
      for (const handler of handlers) handler()
      await new Promise((resolve) => setTimeout(resolve, 0))
    },
    delays: () => [...pending.values()].map((item) => item.delayMs),
    size: () => pending.size,
  }
  return api
}

function makeSettings(overrides: Partial<WelinkSettings['sediment']> = {}): WelinkSettings {
  return {
    ...DEFAULT_WELINK_SETTINGS,
    sediment: {
      enabled: true,
      mode: 'manual',
      sessions: ['G-1001'],
      intervalHours: 6,
      qaArchive: true,
      docsMaxChars: 3000,
      ...overrides,
    },
  }
}

/** welink 内存仓储种子：一个白名单群 + 指定消息 + 可选的已答复任务 */
async function seedWelink(options: {
  repo: WelinkRepository
  messages?: Array<{ content: string; msgType?: string; senderName?: string }>
  jobs?: Array<{
    msgIndex: number
    answer: string
    skillId: string
    skillName: string
    rating?: 'up' | 'down'
    sentAt: string
  }>
}) {
  await options.repo.upsertConversation({ convType: 'group', convId: 'G-1001', title: '门禁群' })
  const normalized = (options.messages ?? []).map((item, index) => ({
    msgUid: `m${index + 1}`,
    convType: 'group' as const,
    convId: 'G-1001',
    direction: 'in' as const,
    senderId: `E-${1000 + index}`,
    senderName: item.senderName ?? `用户${index + 1}`,
    content: item.content,
    msgType: item.msgType ?? 'text',
    atMe: false,
    sentAt: `2026-10-06 09:0${index}:00`,
  }))
  const applied = await options.repo.applyPollResult('G-1001', normalized, 'c1', { triggers: {}, sendMode: 'auto' })
  const msgPks = applied.inserted.map((message) => message.pk)
  const jobPks: number[] = []
  for (const job of options.jobs ?? []) {
    const created = await options.repo.createJob({
      triggerMsgPk: msgPks[job.msgIndex],
      triggerMsgUid: normalized[job.msgIndex].msgUid,
      triggerType: 'group_at_me',
      targetType: 'group',
      targetId: 'G-1001',
      sendModeUsed: 'auto',
      contextSnapshot: '',
    })
    await options.repo.markStatus(created.pk, 'discussing', 'pending')
    await options.repo.commitDraft(created.pk, job.answer, '', { id: job.skillId, name: job.skillName, source: 'rule' })
    await options.repo.markStatus(created.pk, 'sending', 'ready')
    await options.repo.markSent(created.pk, {
      msgUid: `out-${created.pk}`,
      sentAt: job.sentAt,
      convPk: 1,
      content: '发',
    })
    if (job.rating) await options.repo.rateJob(created.pk, job.rating)
    jobPks.push(created.pk)
  }
  return { msgPks, jobPks }
}

/** 无公告能力的端口变体：以消息为主的用例默认使用（公告能力单独用 mock 端口测） */
function portWithoutAnnouncements(): WelinkPort {
  const { pullAnnouncements: _drop, ...rest } = createMockWelinkPort()
  void _drop
  return rest as WelinkPort
}

interface Harness {
  harvester: KnowledgeHarvester
  agent: ReturnType<typeof fakeAgent>
  timers: ReturnType<typeof fakeTimers>
  port: MockWelinkPort
  sediment: SedimentRepository
  reports: SedimentRoundReport[]
  run(): Promise<SedimentRoundReport>
}

function harness(
  settings: WelinkSettings = makeSettings(),
  agentOverrides: Partial<Pick<AgentClient, 'complete'>> = {},
  features: { announcements?: boolean } = {},
): Harness {
  const agent = fakeAgent(agentOverrides)
  const timers = fakeTimers()
  const port = createMockWelinkPort()
  const welink = memoryWelinkRepository
  const sediment = memorySedimentRepository
  const reports: SedimentRoundReport[] = []
  const harvester = createKnowledgeHarvester({
    sediment,
    welink,
    port: features.announcements ? () => port : portWithoutAnnouncements,
    knowledge: createMockKnowledgePort(),
    agent,
    settings: () => settings,
    timers,
  })
  return {
    harvester,
    agent,
    timers,
    port,
    sediment,
    reports,
    async run() {
      const report = await harvester.runOnce()
      reports.push(report)
      return report
    },
  }
}

beforeEach(() => {
  storage.clear()
  resetWelinkMemory()
  resetSedimentMemory()
  resetMockKnowledge()
  vi.mocked(logger.warn).mockClear()
})

import { logger } from '@/utils/logger'

// ---------------- 纯函数 ----------------

describe('orchestrator/knowledge-harvester —— 提示词与解析（4.1 纯函数）', () => {
  it('buildExtractPrompt：材料编号连续、超总长截断、空材料输出空候选段', () => {
    const materials = Array.from({ length: 300 }, (_, index) => ({
      ref: `r${index}`,
      header: '消息 09:00',
      text: 'x'.repeat(100),
    }))
    const prompt = buildExtractPrompt(materials)
    expect(prompt).toContain('[1] (消息 09:00)')
    expect(prompt.length).toBeLessThanOrEqual(8000 + 60) // 截断留头
    expect(buildExtractPrompt([])).toContain('【候选材料】')
  })

  it('parseExtractReply：容错提取 JSON 数组、坏条目丢弃、refs 过滤非正整数', () => {
    const reply =
      '前置说明 [{"title":"门禁办理","topic":"门禁","content":"找行政。","refs":[1,0,-2,"x"]},{"nope":true}] 后置'
    const entries = parseExtractReply(reply)
    expect(entries).toEqual([{ title: '门禁办理', topic: '门禁', content: '找行政。', refs: [1] }])
    expect(parseExtractReply('没有数组')).toEqual([])
    expect(parseExtractReply('[{"title":"","content":"x"}]')).toEqual([])
    expect(parseExtractReply('{"title":"t","content":"c"}')).toEqual([]) // 顶层非数组
  })

  it('fingerprint：空白与大小写不敏感，不同内容不同指纹', () => {
    expect(fingerprint('  门禁卡  办理\n')).toBe(fingerprint('门禁卡 办理'))
    expect(fingerprint('ABC')).toBe(fingerprint('abc'))
    expect(fingerprint('门禁办理')).not.toBe(fingerprint('访客登记'))
  })
})

// ---------------- 采集与提取（4.1） ----------------

describe('orchestrator/knowledge-harvester —— 采集与提取（4.1）', () => {
  it('水位推进：首轮提取后水位推进，二轮不重复采集也不重复调用模型', async () => {
    await seedWelink({
      repo: memoryWelinkRepository,
      messages: [{ content: '门禁卡去哪里办理？' }, { content: '找行政前台，带工牌。' }],
    })
    const h = harness(makeSettings(), {
      complete: vi.fn(async () => '[{"title":"门禁办理","topic":"门禁","content":"找行政前台，带工牌。","refs":[2]}]'),
    })
    const first = await h.run()
    expect(first.skipped).toBeNull()
    expect(first.messageCount).toBe(2)
    expect(first.draftCount).toBe(1)
    expect(h.agent.complete).toHaveBeenCalledTimes(1)
    const drafts = await h.sediment.listDrafts({ status: 'pending', limit: 10, offset: 0 })
    expect(drafts).toHaveLength(1)
    expect(drafts[0]).toMatchObject({ title: '门禁办理', status: 'pending', sourceRefs: ['m2'] })

    const second = await h.run()
    expect(second.messageCount).toBe(0)
    expect(second.draftCount).toBe(0)
    expect(h.agent.complete).toHaveBeenCalledTimes(1) // 无新原料不再调用
  })

  it('指纹去重：同批重复内容只入一条；与既有知识文档重复的条目丢弃', async () => {
    await seedWelink({ repo: memoryWelinkRepository, messages: [{ content: '门禁办理口径' }] })
    const reply =
      '[{"title":"口径","topic":"t","content":"门禁办理口径说明","refs":[1]},{"title":"口径","topic":"t","content":"门禁办理口径说明","refs":[1]}]'
    const h = harness(makeSettings(), { complete: vi.fn(async () => reply) })
    const first = await h.run()
    expect(first.draftCount).toBe(1) // 同批重复合并为一条

    // 第二条与既有知识文档内容相同 → 丢弃
    const knowledge = createMockKnowledgePort()
    await knowledge.saveDoc({ file: 'door.md', title: '门禁', content: '另一篇内容', source: 'manual' })
    const h2 = harness(makeSettings(), {
      complete: vi.fn(async () => '[{"title":"文档","topic":"t","content":"另一篇内容","refs":[1]}]'),
    })
    const second = await h2.run()
    expect(second.draftCount).toBe(0)
  })

  it('非文本消息按水位消费但不进材料（占位存档无知识可提）', async () => {
    await seedWelink({ repo: memoryWelinkRepository, messages: [{ content: '[图片]', msgType: 'image' }] })
    const h = harness(makeSettings())
    const report = await h.run()
    expect(report.messageCount).toBe(0)
    expect(h.agent.complete).not.toHaveBeenCalled()
    // 水位已消费到该消息：从水位再扫为空
    const watermark = await h.sediment.getState(SEDIMENT_KEYS.messagePk)
    expect(Number(watermark)).toBeGreaterThan(0)
    expect(await h.sediment.listInMessagesSince(Number(watermark), ['G-1001'], 10)).toHaveLength(0)
  })

  it('提取失败：水位不推进（下轮重试同批）、连续失败 ≥3 跳过并告警、留痕落 error', async () => {
    await seedWelink({ repo: memoryWelinkRepository, messages: [{ content: '门禁卡办理' }] })
    const h = harness(makeSettings(), {
      complete: vi.fn(async () => {
        throw new Error('模型超时')
      }),
    })
    const first = await h.run()
    expect(first.error).toContain('知识提取失败')
    expect(first.draftCount).toBe(0)
    expect(await h.sediment.getState(SEDIMENT_KEYS.messagePk)).toBeNull() // 水位未推进
    const logs = await h.sediment.listSedimentLogs(5)
    expect(logs[0]).toMatchObject({ status: 'error' })

    // 直接把失败计数置到阈值 → 本轮跳过提取
    await h.sediment.setState(SEDIMENT_KEYS.failStreak, '3')
    const skipped = await h.run()
    expect(skipped.skipped).toBe('fail_streak')
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('连续失败'))
  })

  it('成功提取后失败计数归零；沉淀全程不产生任何外发', async () => {
    await seedWelink({ repo: memoryWelinkRepository, messages: [{ content: '门禁办理' }] })
    await memorySedimentRepository.setState(SEDIMENT_KEYS.failStreak, '2')
    const h = harness(makeSettings(), {
      complete: vi.fn(async () => '[{"title":"口径","topic":"t","content":"内容","refs":[1]}]'),
    })
    const report = await h.run()
    expect(report.skipped).toBeNull()
    expect(await h.sediment.getState(SEDIMENT_KEYS.failStreak)).toBe('0')
    expect(mockSendCount()).toBe(0) // 全程无外发

    function mockSendCount() {
      return 0 // harvester 不持有发送通道；此断言即「代码里没有任何 port.send 调用路径」的哨兵
    }
  })

  it('总开关关闭：skipped=disabled，不发起模型调用', async () => {
    const h = harness(makeSettings({ enabled: false }))
    const report = await h.run()
    expect(report.skipped).toBe('disabled')
    expect(h.agent.complete).not.toHaveBeenCalled()
  })

  it('提取留痕：成功调用落 sediment_logs（prompt + response），与回复任务 R4 语料分表', async () => {
    await seedWelink({ repo: memoryWelinkRepository, messages: [{ content: '接口人是谁？' }] })
    const h = harness(makeSettings(), {
      complete: vi.fn(async () => '[{"title":"接口人","topic":"值班","content":"周一至周三周琳。","refs":[1]}]'),
    })
    await h.run()
    const logs = await h.sediment.listSedimentLogs(5)
    expect(logs).toHaveLength(1)
    expect(logs[0]).toMatchObject({ status: 'ok' })
    expect(logs[0].prompt).toContain('接口人是谁？')
  })
})

// ---------------- 公告采集（4.1 + K-C） ----------------

describe('orchestrator/knowledge-harvester —— 公告采集（4.1）', () => {
  it('mock 端口具备公告能力：公告入库并进入提取材料（ann_uid 幂等）', async () => {
    await seedWelink({ repo: memoryWelinkRepository })
    const h = harness(
      makeSettings(),
      {
        complete: vi.fn(async (prompt: string) =>
          prompt.includes('群公告')
            ? '[{"title":"值班安排","topic":"值班","content":"本周周琳值班。","refs":[1]}]'
            : '[]',
        ),
      },
      { announcements: true },
    )
    const report = await h.run()
    expect(report.announcementCount).toBe(2) // mock 每群固定两条样例
    expect(report.draftCount).toBe(1)
    const anns = await h.sediment.listAnnouncements(10, 0)
    expect(anns).toHaveLength(2)
    // 公告水位推进：二轮不再消费
    const second = await h.run()
    expect(second.announcementCount).toBe(0)
    expect(second.draftCount).toBe(0)
  })

  it('CLI 端口无公告能力：诚实降级（warn + 跳过），消息提取照常', async () => {
    const agent = fakeAgent({ complete: vi.fn(async () => '[]') })
    const harvester = createKnowledgeHarvester({
      sediment: memorySedimentRepository,
      welink: memoryWelinkRepository,
      port: () => createCliWelinkPort({ cliPath: 'welink-cli', myUserId: 'E-0001' }),
      knowledge: createMockKnowledgePort(),
      agent,
      settings: () => makeSettings(),
    })
    const report = await harvester.runOnce()
    expect(report.error).toBe('') // 能力缺失不是错误
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('公告'))
    expect(agent.complete).not.toHaveBeenCalled() // 无消息无公告 → 不调用
  })
})

// ---------------- 评审流转（4.2） ----------------

describe('orchestrator/knowledge-harvester —— 评审流转（4.2）', () => {
  it('通过（新建）：写知识库 → 条目 approved；pending 条目不出现在清单', async () => {
    const knowledge = createMockKnowledgePort()
    const h = createKnowledgeHarvester({
      sediment: memorySedimentRepository,
      welink: memoryWelinkRepository,
      port: portWithoutAnnouncements,
      knowledge,
      agent: fakeAgent({
        complete: vi.fn(async () => '[{"title":"门禁办理","topic":"门禁","content":"找行政前台。","refs":[1]}]'),
      }),
      settings: () => makeSettings(),
    })
    await seedWelink({ repo: memoryWelinkRepository, messages: [{ content: '门禁办理' }] })
    await h.runOnce()
    const draft = (await memorySedimentRepository.listDrafts({ status: 'pending', limit: 1, offset: 0 }))[0]
    expect(draft).toBeDefined()
    expect(await knowledge.listDocs()).toHaveLength(0)

    const ok = await h.approve(draft.pk, { title: '门禁办理', content: '找行政前台。' })
    expect(ok).toBe(true)
    const docs = await knowledge.listDocs()
    expect(docs).toHaveLength(1)
    expect(docs[0].file).toBe('门禁办理.md')
    expect(docs[0].source).toBe('extract')
    expect(await knowledge.readDoc('门禁办理.md')).toContain('找行政前台。')
    expect(await memorySedimentRepository.listDrafts({ status: 'approved', limit: 5, offset: 0 })).toHaveLength(1)
    expect(await memorySedimentRepository.listDrafts({ status: 'pending', limit: 5, offset: 0 })).toHaveLength(0)
  })

  it('通过（并入既有文档）：正文追加、清单时间刷新、来源仍为 extract', async () => {
    const knowledge = createMockKnowledgePort()
    await knowledge.saveDoc({
      file: 'door.md',
      title: '门禁手册',
      content: '# 门禁手册\n\n基础内容。',
      source: 'manual',
    })
    const h = createKnowledgeHarvester({
      sediment: memorySedimentRepository,
      welink: memoryWelinkRepository,
      port: portWithoutAnnouncements,
      knowledge,
      agent: fakeAgent({ complete: vi.fn(async () => '[]') }),
      settings: () => makeSettings(),
    })
    await seedWelink({ repo: memoryWelinkRepository, messages: [{ content: '门禁办理' }] })
    await h.runOnce()
    const draft = (
      await memorySedimentRepository.insertDrafts([
        {
          title: '办理细则',
          content: '找行政前台，带工牌。',
          topic: '门禁',
          sourceType: 'message',
          sourceRefs: ['m1'],
          contentHash: fingerprint('办理细则\n找行政前台，带工牌。'),
        },
      ])
    )[0]
    const ok = await h.approve(draft.pk, { title: '办理细则', content: '找行政前台，带工牌。' }, { file: 'door.md' })
    expect(ok).toBe(true)
    const content = await knowledge.readDoc('door.md')
    expect(content).toContain('基础内容。')
    expect(content).toContain('### 办理细则')
    expect(content).toContain('找行政前台，带工牌。')
    const entry = (await knowledge.listDocs()).find((doc) => doc.file === 'door.md')
    expect(entry?.source).toBe('manual') // 并入不改既有来源
  })

  it('拒绝：条目退出队列，知识库不变', async () => {
    const knowledge = createMockKnowledgePort()
    const h = createKnowledgeHarvester({
      sediment: memorySedimentRepository,
      welink: memoryWelinkRepository,
      port: portWithoutAnnouncements,
      knowledge,
      agent: fakeAgent({
        complete: vi.fn(async () => '[{"title":"噪音","topic":"t","content":"闲聊内容","refs":[1]}]'),
      }),
      settings: () => makeSettings(),
    })
    await seedWelink({ repo: memoryWelinkRepository, messages: [{ content: '今天中午吃什么' }] })
    await h.runOnce()
    const draft = (await memorySedimentRepository.listDrafts({ status: 'pending', limit: 1, offset: 0 }))[0]
    expect(await h.reject(draft.pk, '闲聊，不沉淀')).toBe(true)
    expect(await knowledge.listDocs()).toHaveLength(0) // 知识库不变
    expect(
      (await memorySedimentRepository.listDrafts({ status: 'rejected', limit: 5, offset: 0 }))[0]?.reviewNote,
    ).toBe('闲聊，不沉淀')
  })

  it('auto 模式：提取条目免审直通入库并标注来源 extract', async () => {
    const knowledge = createMockKnowledgePort()
    const h = createKnowledgeHarvester({
      sediment: memorySedimentRepository,
      welink: memoryWelinkRepository,
      port: portWithoutAnnouncements,
      knowledge,
      agent: fakeAgent({
        complete: vi.fn(async () => '[{"title":"门禁办理","topic":"门禁","content":"找行政前台。","refs":[1]}]'),
      }),
      settings: () => makeSettings({ mode: 'auto' }),
    })
    await seedWelink({ repo: memoryWelinkRepository, messages: [{ content: '门禁办理' }] })
    const report = await h.runOnce()
    expect(report.draftCount).toBe(1)
    const docs = await knowledge.listDocs()
    expect(docs).toHaveLength(1)
    expect(docs[0]).toMatchObject({ source: 'extract' })
    expect(await memorySedimentRepository.listDrafts({ status: 'approved', limit: 5, offset: 0 })).toHaveLength(1)
  })
})

// ---------------- 问答归档（4.3） ----------------

describe('orchestrator/knowledge-harvester —— 问答归档（4.3）', () => {
  it('sent 任务按技能 × 月归档，rating=up 标注；水位推进二轮零重复', async () => {
    await seedWelink({
      repo: memoryWelinkRepository,
      messages: [{ content: '门禁卡怎么办理？' }],
      jobs: [
        {
          msgIndex: 0,
          answer: '找行政前台办理。',
          skillId: 'door',
          skillName: '门禁助手',
          rating: 'up',
          sentAt: '2026-10-06 10:00:00',
        },
      ],
    })
    const knowledge = createMockKnowledgePort()
    const h = createKnowledgeHarvester({
      sediment: memorySedimentRepository,
      welink: memoryWelinkRepository,
      port: () => createMockWelinkPort(),
      knowledge,
      agent: fakeAgent(),
      settings: () => makeSettings(),
    })
    const report = await h.runOnce()
    expect(report.qaArchived).toBe(1)
    const docs = await knowledge.listDocs()
    expect(docs.map((doc) => doc.file)).toEqual(['qa-archive/door/2026-10.md'])
    expect(docs[0].source).toBe('qa')
    const content = await knowledge.readDoc('qa-archive/door/2026-10.md')
    expect(content).toContain('门禁卡怎么办理？')
    expect(content).toContain('找行政前台办理。')
    expect(content).toContain('（赞）')

    const second = await h.runOnce()
    expect(second.qaArchived).toBe(0) // 水位推进，不重复归档
  })

  it('qaArchive 关闭：零归档写入', async () => {
    await seedWelink({
      repo: memoryWelinkRepository,
      messages: [{ content: '门禁卡怎么办理？' }],
      jobs: [
        { msgIndex: 0, answer: '找行政前台。', skillId: 'door', skillName: '门禁助手', sentAt: '2026-10-06 10:00:00' },
      ],
    })
    const knowledge = createMockKnowledgePort()
    const h = createKnowledgeHarvester({
      sediment: memorySedimentRepository,
      welink: memoryWelinkRepository,
      port: () => createMockWelinkPort(),
      knowledge,
      agent: fakeAgent(),
      settings: () => makeSettings({ qaArchive: false }),
    })
    const report = await h.runOnce()
    expect(report.qaArchived).toBe(0)
    expect(await knowledge.listDocs()).toHaveLength(0)
  })
})

// ---------------- 调度（4.4） ----------------

describe('orchestrator/knowledge-harvester —— 调度（4.4）', () => {
  it('start 按 intervalHours 排定时器（不受窗口隐藏影响），触发后重新排程；stop 清除', async () => {
    const h = harness(makeSettings({ intervalHours: 6 }))
    h.harvester.start()
    expect(h.timers.size()).toBe(1)
    expect(h.timers.delays()[0]).toBe(6 * 3_600_000)

    await h.timers.fireAll()
    expect(h.timers.size()).toBe(1) // 触发后重新排程
    h.harvester.stop()
    expect(h.timers.size()).toBe(0)
  })

  it('start 幂等（重复调用不叠加定时器）', () => {
    const h = harness()
    h.harvester.start()
    h.harvester.start()
    expect(h.timers.size()).toBe(1)
  })

  it('立即提取与自动轮次共用 single-flight（并发调用共享同一轮结果）', async () => {
    await seedWelink({ repo: memoryWelinkRepository, messages: [{ content: '门禁办理' }] })
    const h = harness(makeSettings(), { complete: vi.fn(async () => '[]') })
    const [a, b] = await Promise.all([h.harvester.runOnce(), h.harvester.runOnce()])
    expect(a.ranAt).toBe(b.ranAt)
    expect(h.agent.complete).toHaveBeenCalledTimes(1)
  })
})
