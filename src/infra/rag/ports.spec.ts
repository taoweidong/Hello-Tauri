import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * RAG 端口契约测试（设计 docs/design-welink-rag-retrieval-2026-10-05.md §6.3/§7）。
 *
 * rag-http 与 agent-http 同构（transport 注入/超时分类/IP 守卫），这里钉住的是
 * RAG 特有的部分：请求体形状（query/top_k/filter）、响应候选字段容错、
 * mock 的确定性命中与故障注入、浏览器强制 mock。
 */
import type { RagHttpTransport } from './rag-http'
import { createHttpRag, probeRagOnce } from './rag-http'
import { MOCK_RAG_CORPUS, createMockRag } from './mock'
import type { WelinkRagSettings } from '@/types/welink'

const OK_TRANSPORT: RagHttpTransport = async () => ({
  status: 200,
  body: JSON.stringify({ results: [{ content: '先查网关日志', score: 0.91, source: 'ts.md' }] }),
})

const httpOptions = (overrides: Partial<Parameters<typeof createHttpRag>[0]> = {}): Parameters<typeof createHttpRag>[0] => ({
  baseUrl: 'http://rag.intranet.local',
  endpoint: '/search',
  apiKey: '',
  topK: 4,
  timeoutMs: 5000,
  transport: OK_TRANSPORT,
  ...overrides,
})

beforeEach(() => {
  vi.stubGlobal('window', { fetch: vi.fn(async () => ({ status: 200, text: async () => '{}' })) })
})
afterEach(() => {
  vi.unstubAllGlobals()
})

describe('infra/rag —— mock 检索（确定性命中与故障注入）', () => {
  it('query 命中语料关键词：返回片段（score 递减、带来源），onCall 记录成功', async () => {
    const mock = createMockRag()
    let seen = 0
    mock.onCall((record) => {
      seen += 1
      expect(record.error).toBe('')
    })
    const chunks = await mock.retrieve({ query: '登录页报错了怎么排查' })
    expect(chunks.length).toBeGreaterThan(0)
    expect(chunks[0].source).toBe(Object.values(MOCK_RAG_CORPUS)[0][0].source)
    expect(chunks.map((c) => c.score)).toEqual([...chunks.map((c) => c.score)].sort((a, b) => b - a))
    expect(seen).toBe(1)
  })

  it('零命中返回空数组（演示降级路径），failNext 抛 transport 错', async () => {
    const mock = createMockRag()
    await expect(mock.retrieve({ query: '完全无关的问题' })).resolves.toEqual([])
    mock.failNext(1)
    await expect(mock.retrieve({ query: '报错' })).rejects.toMatchObject({ kind: 'transport' })
    await expect(mock.retrieve({ query: '报错' })).resolves.toHaveLength(2)
  })
})

describe('infra/rag —— rag-http 请求形状与解析', () => {
  it('请求体为 {query, top_k}，query.filter 存在时透传；apiKey 非空带 Bearer（trim）', async () => {
    const transport = vi.fn(
      async () => ({ status: 200, body: JSON.stringify({ results: [{ content: 'x', score: 0.5 }] }) }) as never,
    ) as unknown as RagHttpTransport
    const client = createHttpRag(httpOptions({ apiKey: ' sk-1 ', transport }))
    await client.retrieve({ query: '报 500', filter: ' 故障 ' })
    const [url, headers, body] = (transport as ReturnType<typeof vi.fn>).mock.calls[0] as [string, Record<string, string>, string]
    expect(url).toBe('http://rag.intranet.local/search')
    expect(headers.authorization).toBe('Bearer sk-1')
    expect(JSON.parse(body)).toEqual({ query: '报 500', top_k: 4, filter: '故障' })
  })

  it('apiKey 为空不带鉴权头；query.topK 覆盖缺省 topK', async () => {
    const transport = vi.fn(async () => ({ status: 200, body: JSON.stringify({ results: [] }) })) as unknown as RagHttpTransport
    const client = createHttpRag(httpOptions({ transport }))
    await client.retrieve({ query: 'x', topK: 7 })
    const [, headers, body] = (transport as ReturnType<typeof vi.fn>).mock.calls[0] as [string, Record<string, string>, string]
    expect(headers.authorization).toBeUndefined()
    expect(JSON.parse(body).top_k).toBe(7)
  })

  it('响应候选字段容错：chunks 容器 + text 正文 + similarity 分值 + doc 来源', async () => {
    const transport: RagHttpTransport = async () => ({
      status: 200,
      body: JSON.stringify({ chunks: [{ text: '片段正文', similarity: 0.77, doc: 'faq.md' }] }),
    })
    const client = createHttpRag(httpOptions({ transport }))
    const chunks = await client.retrieve({ query: 'x' })
    expect(chunks).toEqual([{ content: '片段正文', score: 0.77, source: 'faq.md' }])
  })

  it('非 2xx → transport 错；非 JSON 与无片段数组 → parse 错', async () => {
    const bad: RagHttpTransport = async () => ({ status: 503, body: 'unavailable' })
    await expect(createHttpRag(httpOptions({ transport: bad })).retrieve({ query: 'x' })).rejects.toMatchObject({
      kind: 'transport',
    })
    const notJson: RagHttpTransport = async () => ({ status: 200, body: '<html>' })
    await expect(createHttpRag(httpOptions({ transport: notJson })).retrieve({ query: 'x' })).rejects.toMatchObject({
      kind: 'parse',
    })
    const noChunks: RagHttpTransport = async () => ({ status: 200, body: JSON.stringify({ answer: 'x' }) })
    await expect(createHttpRag(httpOptions({ transport: noChunks })).retrieve({ query: 'x' })).rejects.toMatchObject({
      kind: 'parse',
    })
  })

  it('transport 抛错/超时中止归 transport/timeout 分类；公网 literal IP 直接拒绝', async () => {
    const boom: RagHttpTransport = async () => {
      throw new Error('ECONNREFUSED')
    }
    await expect(createHttpRag(httpOptions({ transport: boom })).retrieve({ query: 'x' })).rejects.toMatchObject({
      kind: 'transport',
    })
    const slow: RagHttpTransport = (_url, _h, _b, timeoutMs) =>
      new Promise((resolve) => setTimeout(() => resolve({ status: 200, body: '{}' }), timeoutMs + 50))
    await expect(createHttpRag(httpOptions({ transport: slow, timeoutMs: 50 })).retrieve({ query: 'x' })).rejects.toMatchObject(
      { kind: 'transport' },
    )
    const client = createHttpRag(httpOptions({ baseUrl: 'http://8.8.8.8' }))
    await expect(client.retrieve({ query: 'x' })).rejects.toThrow('公网 IP')
  })

  it('probeRagOnce：命中给片段摘要、零命中给可达提示', async () => {
    const hit = await probeRagOnce(httpOptions())
    expect(hit.preview).toContain('先查网关日志')
    const empty: RagHttpTransport = async () => ({ status: 200, body: JSON.stringify({ results: [] }) })
    const zero = await probeRagOnce(httpOptions({ transport: empty }))
    expect(zero.preview).toContain('零命中')
  })
})

describe('infra/rag —— 工厂与安全守卫', () => {
  it('ragSource=http 且 baseUrl 空 → 回退 mock（failNext 可见）', async () => {
    const { ragClient, resetRagClient } = await import('./index')
    resetRagClient()
    const settings: WelinkRagSettings = {
      ragSource: 'http',
      baseUrl: '   ',
      endpoint: '/search',
      apiKey: '',
      timeoutMs: 5000,
      topK: 4,
      minScore: 0,
      maxChars: 1200,
      fallbackRetrieve: false,
    }
    const client = ragClient({ settings })
    expect(typeof (client as unknown as { failNext?: unknown }).failNext).toBe('function')
    resetRagClient()
  })
})
