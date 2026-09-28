import { describe, expect, it, vi } from 'vitest'

/**
 * Agent 端口夹具（设计 §13「夹具双实现」）。
 *
 * 本文件覆盖与实现无关的契约：mock 先跑，真实内网 SDK 到位后同一套断言
 * 直接跑在 `createHttpAgent` 上。
 *
 * 重点在两处「错了会静默劣化」的地方：
 *  1. **onCall 恒触发**（R4）—— 失败样本恰是改进提示词最有价值的语料，
 *     只记录成功等于丢掉了 R4 的一半价值；
 *  2. **timeout 与 error 必须分类**（AgentError.kind）—— 混在一起后
 *     「服务慢」与「服务坏」无法区分，UI 错误详情与回溯筛选都会失真。
 */

import type { AgentCallRecord } from '@/infra/agent/port'
import { AgentError } from '@/infra/agent/port'
import { createMockAgent } from '@/infra/agent/mock'
import { createHttpAgent, probeAgent } from '@/infra/agent/agent-http'
import {
  formatContextLine,
  missingPlaceholders,
  renderPrompt,
  sanitizeReply,
  unknownPlaceholders,
} from '@/infra/agent/prompt'
import type { WelinkConversation, WelinkMessage } from '@/types/welink'

const TARGET: WelinkConversation = {
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
}

function message(overrides: Partial<WelinkMessage> = {}): WelinkMessage {
  return {
    pk: 1,
    convPk: 1,
    msgUid: 'm-1',
    convType: 'group',
    convId: 'G-1001',
    direction: 'in',
    senderId: 'E-9001',
    senderName: '赵敏',
    content: '@你 接口文档更新了',
    msgType: 'text',
    atMe: true,
    readFlag: false,
    sentAt: '2026-09-27 14:03:00',
    ...overrides,
  }
}

describe('infra/agent —— AgentError 分类', () => {
  it('kind 必填且 name 固定（R4 语料按 kind 分列）', () => {
    expect(new AgentError('超时', 'timeout')).toMatchObject({ kind: 'timeout', name: 'AgentError' })
    expect(new AgentError('坏', 'error')).toMatchObject({ kind: 'error', name: 'AgentError' })
  })

  it('保留 cause', () => {
    const cause = new Error('inner')
    expect(new AgentError('outer', 'error', cause).cause).toBe(cause)
  })
})

describe('infra/agent —— prompt 渲染', () => {
  it('上下文行格式是 [时间] 昵称：内容（时间截到分）', () => {
    expect(formatContextLine(message())).toBe('[09-27 14:03] 赵敏：@你 接口文档更新了')
  })

  it('out 消息的作者显示为「我」（提示词里方向要能看出来）', () => {
    expect(formatContextLine(message({ direction: 'out', senderName: '' }))).toContain('] 我：')
  })

  it('无昵称时回落到 senderId，仍无则「对方」', () => {
    expect(formatContextLine(message({ senderName: '', senderId: 'E-9' }))).toContain('] E-9：')
    expect(formatContextLine(message({ senderName: '', senderId: '' }))).toContain('] 对方：')
  })

  it('四个占位符全部替换（含 remark 拼进目标名）', () => {
    const text = renderPrompt({
      template: '目标={{target}} 对方={{sender}}\n历史：\n{{context}}\n要回：{{question}}',
      target: { ...TARGET, remark: '重点项目' },
      context: [message({ content: '上一句' })],
      trigger: message({ content: '这句要回' }),
    })
    expect(text).toContain('目标=研发一组（重点项目）')
    expect(text).toContain('对方=赵敏')
    expect(text).toContain('[09-27 14:03] 赵敏：上一句')
    expect(text).toContain('要回：这句要回')
  })

  it('空上下文渲染成占位文案（不是空字符串，模型才不会困惑）', () => {
    const text = renderPrompt({ template: '{{context}}', target: TARGET, context: [], trigger: message() })
    expect(text).toBe('（暂无历史消息）')
  })

  it('缺触发消息时给出可理解的兜底文案', () => {
    const text = renderPrompt({ template: '{{question}}', target: TARGET, context: [], trigger: null })
    expect(text).toContain('未取到触发消息')
  })

  it('目标名回退链：title → remark → fallback → convId', () => {
    const base = { template: '{{target}}', context: [], trigger: message() }
    expect(renderPrompt({ ...base, target: null, targetFallback: '兜底名' })).toBe('兜底名')
    expect(renderPrompt({ ...base, target: null })).toBe('G-1001')
  })

  it('未知占位符原样保留（不静默吞掉用户的模板意图）', () => {
    const text = renderPrompt({
      template: '{{target}} {{myUnknown}}',
      target: TARGET,
      context: [],
      trigger: message(),
    })
    expect(text).toContain('{{myUnknown}}')
  })

  it('missingPlaceholders 只把 context/question 视为必需', () => {
    expect(missingPlaceholders('{{context}}{{question}}')).toEqual([])
    expect(missingPlaceholders('{{context}}')).toEqual(['{{question}}'])
    expect(missingPlaceholders('{{sender}}{{target}}')).toEqual(['{{context}}', '{{question}}'])
  })

  it('unknownPlaceholders 去重并排除已知四项', () => {
    expect(unknownPlaceholders('{{context}}{{question}}{{sender}}{{target}}')).toEqual([])
    expect(unknownPlaceholders('{{x}} {{y}} {{x}}')).toEqual(['{{x}}', '{{y}}'])
  })
})

describe('infra/agent —— sanitizeReply（保守清理包裹痕迹）', () => {
  it('去掉三引号代码块包裹', () => {
    expect(sanitizeReply('```\n收到，我看下\n```')).toBe('收到，我看下')
    expect(sanitizeReply('```json\n{"a":1}\n```')).toBe('{"a":1}')
  })

  it('去掉「回复：」类前缀', () => {
    expect(sanitizeReply('回复：收到')).toBe('收到')
    expect(sanitizeReply('Reply: ok')).toBe('ok')
  })

  it('去掉整体引号包裹（三种引号）', () => {
    expect(sanitizeReply('"收到"')).toBe('收到')
    expect(sanitizeReply('“收到”')).toBe('收到')
    expect(sanitizeReply('「收到」')).toBe('收到')
  })

  it('连续空行压成单个换行', () => {
    expect(sanitizeReply('第一行\n\n\n第二行')).toBe('第一行\n第二行')
  })

  it('不改动正文内容本身（保守清理）', () => {
    expect(sanitizeReply('这段内容里有"引号"，但不在首尾')).toBe('这段内容里有"引号"，但不在首尾')
  })
})

describe('infra/agent —— mock 客户端契约', () => {
  it('complete 返回非空回复', async () => {
    const agent = createMockAgent()
    await expect(agent.complete('【需要回复的消息】\n你好')).resolves.toBeTruthy()
  })

  it('失败注入归为 error 类（不是 timeout）', async () => {
    const agent = createMockAgent({ failures: 1 })
    await expect(agent.complete('p')).rejects.toMatchObject({ kind: 'error' })
    await expect(agent.complete('p')).resolves.toBeTruthy()
  })

  it('超时注入归为 timeout 类', async () => {
    const agent = createMockAgent({ timeouts: 1 })
    await expect(agent.complete('p')).rejects.toMatchObject({ kind: 'timeout' })
  })

  it('failNext 可随时追加失败次数', async () => {
    const agent = createMockAgent()
    await agent.complete('p')
    agent.failNext(2)
    await expect(agent.complete('p')).rejects.toBeInstanceOf(AgentError)
    await expect(agent.complete('p')).rejects.toBeInstanceOf(AgentError)
    await expect(agent.complete('p')).resolves.toBeTruthy()
  })

  it('onCall 在成功时记录（calls 与 handler 都收到完整记录）', async () => {
    const agent = createMockAgent()
    const seen: AgentCallRecord[] = []
    agent.onCall((record) => seen.push(record))
    const reply = await agent.complete('【需要回复的消息】\n你好')
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ status: 'ok', error: '', response: reply })
    expect(seen[0].latencyMs).toBeGreaterThanOrEqual(0)
    expect(agent.calls).toHaveLength(1)
  })

  it('onCall 在失败时同样触发（R4：失败样本才有改进价值）', async () => {
    const agent = createMockAgent({ failures: 1 })
    const seen: AgentCallRecord[] = []
    agent.onCall((record) => seen.push(record))
    await expect(agent.complete('p')).rejects.toBeInstanceOf(AgentError)
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ status: 'error', response: '' })
    expect(seen[0].error).toContain('服务错误')
  })

  it('onCall 超时样本的 status 是 timeout（与 error 分列）', async () => {
    const agent = createMockAgent({ timeouts: 1 })
    const seen: AgentCallRecord[] = []
    agent.onCall((record) => seen.push(record))
    await expect(agent.complete('p')).rejects.toMatchObject({ kind: 'timeout' })
    expect(seen[0].status).toBe('timeout')
  })

  it('多个 onCall 处理器都会被调用', async () => {
    const agent = createMockAgent()
    const a = vi.fn()
    const b = vi.fn()
    agent.onCall(a)
    agent.onCall(b)
    await agent.complete('p')
    expect(a).toHaveBeenCalledTimes(1)
    expect(b).toHaveBeenCalledTimes(1)
  })

  it('onCall 处理器自身抛错不影响主流程（录音不反噬业务）', async () => {
    const agent = createMockAgent()
    agent.onCall(() => {
      throw new Error('录音挂了')
    })
    await expect(agent.complete('p')).resolves.toBeTruthy()
  })

  it('自定义模板（字符串形式）替换 {{question}} 与 {{sender}}', async () => {
    const agent = createMockAgent({ template: '致{{sender}}：{{question}}' })
    const reply = await agent.complete('【对方】 赵敏\n【需要回复的消息】\n接口更新了')
    expect(reply).toBe('致赵敏：接口更新了')
  })

  it('自定义模板（函数形式）可完全接管输出', async () => {
    const agent = createMockAgent({ template: () => '固定回复' })
    await expect(agent.complete('随便什么')).resolves.toBe('固定回复')
  })

  it('默认模板对「报 500」类问题给出针对性回复（可演示的真实感）', async () => {
    const agent = createMockAgent()
    const reply = await agent.complete('【对方】 李明\n【需要回复的消息】\n客户反馈登录页报 500')
    expect(reply).toContain('日志')
    expect(reply).toContain('李明')
  })

  it('默认模板对「进度/时间」类问题给出承诺式回复', async () => {
    const agent = createMockAgent()
    const reply = await agent.complete('【需要回复的消息】\n这个需求什么时候能好')
    expect(reply).toContain('进度')
  })

  it('mock 输出经过 sanitizeReply（不留包裹痕迹）', async () => {
    const agent = createMockAgent({ template: '```\n包裹的回复\n```' })
    await expect(agent.complete('p')).resolves.toBe('包裹的回复')
  })

  it('reset 清空 calls 与失败计数', async () => {
    const agent = createMockAgent({ failures: 1 })
    await expect(agent.complete('p')).rejects.toBeTruthy()
    agent.reset()
    expect(agent.calls).toHaveLength(0)
    await expect(agent.complete('p')).resolves.toBeTruthy()
  })
})

describe('infra/agent —— HTTP 客户端（真实实现的形状，用假 fetch 验证）', () => {
  function jsonResponse(body: unknown, status = 200) {
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
      text: async () => JSON.stringify(body),
    } as unknown as Response
  }

  it('拼 URL 时消除 baseUrl 末尾与 endpoint 开头重复的斜杠', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: unknown) => jsonResponse({ reply: 'ok' }))
    vi.stubGlobal('fetch', fetchMock)
    const agent = createHttpAgent({ baseUrl: 'http://10.0.0.1:8080/', endpoint: '/v1/complete', timeoutMs: 1000 })
    await agent.complete('p')
    expect(fetchMock.mock.calls[0]![0]).toBe('http://10.0.0.1:8080/v1/complete')
    vi.unstubAllGlobals()
  })

  it('请求体是 { prompt }，content-type 为 JSON（D3 的最小协议）', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: unknown) => jsonResponse({ reply: 'ok' }))
    vi.stubGlobal('fetch', fetchMock)
    const agent = createHttpAgent({ baseUrl: 'http://x', endpoint: '/c', timeoutMs: 1000 })
    await agent.complete('这里的提示词')
    const init = fetchMock.mock.calls[0]![1] as unknown as RequestInit
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body as string)).toEqual({ prompt: '这里的提示词' })
    vi.unstubAllGlobals()
  })

  it('响应字段名容错：reply / response / result / text / choices[0].message', async () => {
    for (const body of [
      { reply: 'r1' },
      { response: 'r2' },
      { result: 'r3' },
      { text: 'r4' },
      { data: { content: 'r5' } },
      { choices: [{ message: { content: 'r6' } }] },
    ]) {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => jsonResponse(body)),
      )
      const agent = createHttpAgent({ baseUrl: 'http://x', endpoint: '/c', timeoutMs: 1000 })
      await expect(agent.complete('p')).resolves.toBeTruthy()
      vi.unstubAllGlobals()
    }
  })

  it('HTTP 非 2xx → error 类（含状态码）', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ error: 'bad' }, 500)),
    )
    const agent = createHttpAgent({ baseUrl: 'http://x', endpoint: '/c', timeoutMs: 1000 })
    await expect(agent.complete('p')).rejects.toMatchObject({ kind: 'error' })
    await expect(agent.complete('p')).rejects.toThrow(/HTTP 500/)
    vi.unstubAllGlobals()
  })

  it('响应里找不到正文字段 → error 类（不静默返回空串）', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ unrelated: 1 })),
    )
    const agent = createHttpAgent({ baseUrl: 'http://x', endpoint: '/c', timeoutMs: 1000 })
    await expect(agent.complete('p')).rejects.toThrow(/未找到回复正文字段/)
    vi.unstubAllGlobals()
  })

  it('网络异常 → error 类，onCall 仍留痕', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ECONNREFUSED')
      }),
    )
    const agent = createHttpAgent({ baseUrl: 'http://x', endpoint: '/c', timeoutMs: 1000 })
    const seen: AgentCallRecord[] = []
    agent.onCall((record) => seen.push(record))
    await expect(agent.complete('p')).rejects.toMatchObject({ kind: 'error' })
    expect(seen).toHaveLength(1)
    expect(seen[0].status).toBe('error')
    vi.unstubAllGlobals()
  })

  it('并发的两次调用各自留痕（1:N 语料的前提）', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ reply: 'ok' })),
    )
    const agent = createHttpAgent({ baseUrl: 'http://x', endpoint: '/c', timeoutMs: 1000 })
    const seen: AgentCallRecord[] = []
    agent.onCall((record) => seen.push(record))
    await Promise.all([agent.complete('p1'), agent.complete('p2')])
    expect(seen).toHaveLength(2)
    expect(seen.map((item) => item.prompt).sort()).toEqual(['p1', 'p2'])
    vi.unstubAllGlobals()
  })

  it('probeAgent 返回耗时与回复摘要（Settings 连通性按钮）', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ reply: 'ok' })),
    )
    const result = await probeAgent({ baseUrl: 'http://x', endpoint: '/c', timeoutMs: 1000 })
    expect(result.preview).toBe('ok')
    expect(result.latencyMs).toBeGreaterThanOrEqual(0)
    vi.unstubAllGlobals()
  })

  it('probeAgent 失败时抛出（按钮据此显示失败态）', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('连不上')
      }),
    )
    await expect(probeAgent({ baseUrl: 'http://x', endpoint: '/c', timeoutMs: 1000 })).rejects.toBeInstanceOf(
      AgentError,
    )
    vi.unstubAllGlobals()
  })
})
