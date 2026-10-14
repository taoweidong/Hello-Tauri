import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createHttpRag, probeRagOnce, type RagHttpTransport } from './rag-http'

/**
 * rag-http 的**独立回归出口**（第二轮补缺口，N1）。
 *
 * 与 `ports.spec.ts` 的分工同 agent 侧：那边钉协议形状（请求体 query/top_k/filter、
 * 容器字段容错、状态与超时分类），这里钉**残余分支**与 `[RAG-ASSUME]` 里最脆的两条
 * ——「候选字段全取不到时到底算错还是算零命中」「片段里缺字段会不会把整段丢掉」。
 * 检索是生成段的输入，静默拿到空数组的后果是「回复里少了知识依据但看起来一切正常」。
 */

const httpOptions = (
  overrides: Partial<Parameters<typeof createHttpRag>[0]> = {},
): Parameters<typeof createHttpRag>[0] => ({
  baseUrl: 'http://rag.intranet.local',
  endpoint: '/search',
  topK: 4,
  timeoutMs: 5000,
  ...overrides,
})

const ok = (payload: string): RagHttpTransport => async () => ({ status: 200, body: payload })

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => ({ status: 200, text: async () => '{}' })))
})
afterEach(() => {
  vi.unstubAllGlobals()
})

describe('infra/rag —— rag-http 解析容错（[RAG-ASSUME] 4）', () => {
  it('容器字段按 results → chunks → hits → data 依次尝试，取第一个是数组的', async () => {
    const payload = JSON.stringify({ code: 0, hits: [{ chunk: '来自 hits 的片段', score: 0.4, title: 'a.md' }] })
    const client = createHttpRag(httpOptions({ transport: ok(payload) }))
    await expect(client.retrieve({ query: 'x' })).resolves.toEqual([
      { content: '来自 hits 的片段', score: 0.4, source: 'a.md' },
    ])
  })

  it('片段缺正文字段 → 整条跳过（宁可少给，也不给空片段污染提示词）', async () => {
    const payload = JSON.stringify({
      results: [{ content: '有正文', score: 0.9 }, { score: 0.8 }, { text: '   ' }, 'not an object'],
    })
    const client = createHttpRag(httpOptions({ transport: ok(payload) }))
    await expect(client.retrieve({ query: 'x' })).resolves.toEqual([
      { content: '有正文', score: 0.9, source: '' },
    ])
  })

  it('分值缺失或非数字 → 落 0（阈值过滤在编排层，这里只保证不出现 NaN）', async () => {
    const payload = JSON.stringify({
      results: [
        { content: '无分值' },
        { content: '分值是字符串', score: '0.9' },
        { content: '分值是 NaN', score: null },
      ],
    })
    const client = createHttpRag(httpOptions({ transport: ok(payload) }))
    const chunks = await client.retrieve({ query: 'x' })
    expect(chunks.map((chunk) => chunk.score)).toEqual([0, 0, 0])
    expect(chunks.every((chunk) => Number.isNaN(chunk.score))).toBe(false)
  })

  it('来源取不到给空串（编排层拼引用时有判据，不假造来源）', async () => {
    const client = createHttpRag(httpOptions({ transport: ok(JSON.stringify({ results: [{ content: 'x' }] })) }))
    await expect(client.retrieve({ query: 'x' })).resolves.toEqual([{ content: 'x', score: 0, source: '' }])
  })

  it('容器存在但是空数组 → 零命中正常返回（不是 parse 错误）', async () => {
    const client = createHttpRag(httpOptions({ transport: ok(JSON.stringify({ results: [] })) }))
    await expect(client.retrieve({ query: 'x' })).resolves.toEqual([])
  })

  it('响应是数组或非对象 → parse 错误（端点可能不是检索接口）', async () => {
    const client = createHttpRag(httpOptions({ transport: ok('[1,2,3]') }))
    await expect(client.retrieve({ query: 'x' })).rejects.toMatchObject({ kind: 'parse' })
  })
})

describe('infra/rag —— rag-http 异常与守卫分支', () => {
  it('onCall 钩子抛错不影响返回（检索留痕不能反噬生成段）', async () => {
    const client = createHttpRag(
      httpOptions({ transport: ok(JSON.stringify({ results: [{ content: 'x', score: 1 }] })) }),
    )
    client.onCall(() => {
      throw new Error('钩子炸了')
    })
    await expect(client.retrieve({ query: 'x' })).resolves.toHaveLength(1)
  })

  it('宿主通道 reject 一个非 Error → transport 类且消息被 String() 化', async () => {
    const transport = (() => Promise.reject('TLS 握手失败')) as unknown as RagHttpTransport
    const client = createHttpRag(httpOptions({ transport }))
    await expect(client.retrieve({ query: 'x' })).rejects.toMatchObject({
      kind: 'transport',
      message: 'TLS 握手失败',
    })
  })

  it('非 2xx 且响应体为空 → 错误消息不拖空冒号', async () => {
    const empty: RagHttpTransport = async () => ({ status: 504, body: '' })
    await expect(createHttpRag(httpOptions({ transport: empty })).retrieve({ query: 'x' })).rejects.toThrow(
      'RAG 返回 HTTP 504',
    )
  })

  it('filter 只有空白时不进请求体（不把空筛选条件发给服务端）', async () => {
    const transport = vi.fn(ok(JSON.stringify({ results: [] })))
    await createHttpRag(httpOptions({ transport })).retrieve({ query: 'x', filter: '   ' })
    expect(JSON.parse(String(transport.mock.calls[0][2]))).toEqual({ query: 'x', top_k: 4 })
  })

  it('公网 literal IP 拒绝；回环与内网段放行（对话原文不得外带）', async () => {
    const transport = vi.fn(ok(JSON.stringify({ results: [] })))
    await expect(
      createHttpRag(httpOptions({ baseUrl: 'http://203.0.113.9', transport })).retrieve({ query: 'x' }),
    ).rejects.toThrow(/公网 IP/)
    await createHttpRag(httpOptions({ baseUrl: 'http://10.2.3.4', transport })).retrieve({ query: 'x' })
    await createHttpRag(httpOptions({ baseUrl: 'http://127.0.0.1', transport })).retrieve({ query: 'x' })
    expect(transport).toHaveBeenCalledTimes(2)
  })

  it('地址无法解析 → transport 错误且给出「地址无法解析」', async () => {
    const client = createHttpRag(httpOptions({ baseUrl: 'ht tp://坏地址' }))
    await expect(client.retrieve({ query: 'x' })).rejects.toThrow(/地址无法解析/)
  })
})

describe('infra/rag —— probeRagOnce 预览', () => {
  it('有命中时预览带分值且截断到 120 字符', async () => {
    const long = '很长的片段正文'.repeat(40)
    const result = await probeRagOnce(
      httpOptions({ transport: ok(JSON.stringify({ results: [{ content: long, score: 0.87 }] })) }),
    )
    expect(result.preview).toContain('[0.87]')
    expect(result.preview.length).toBeLessThanOrEqual(120)
  })

  it('零命中时给「服务可达」而不是空串（配置者据此区分「没配好」与「没这条知识」）', async () => {
    const result = await probeRagOnce(httpOptions({ transport: ok(JSON.stringify({ results: [] })) }))
    expect(result.preview).toBe('（服务可达，本次零命中）')
  })
})
