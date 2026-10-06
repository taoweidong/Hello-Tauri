/**
 * RAG HTTP 实现 —— 真实检索服务的唯一改动面，模式与 `infra/agent/agent-http.ts`
 * 完全同构（transport 组合点 / AbortController 超时 / timeout|error 分类 / onCall
 * 恒触发 / 公网 literal IP 守卫）。
 *
 * [RAG-ASSUME] 对真实检索服务的协议假设（对接前 `grep -rn "RAG-ASSUME" src/`
 * 逐项核实，核实后更新或删除；清单原文见
 * `docs/design-welink-rag-retrieval-2026-10-05.md` §7）：
 *   1. 端点：POST `{baseUrl}{endpoint}`（惯用 `/search`）；
 *   2. 鉴权：`Authorization: Bearer <apiKey>`（非空才带头；自定义头需改 buildRequestParts）；
 *   3. 请求体：`{ query, top_k, filter? }`（filter 空省略；top_k 缺省走服务端默认）；
 *   4. 响应形状（候选字段容错）：
 *        容器 results|chunks|hits|data → 片段数组；
 *        正文 content|text|chunk；分值 score|similarity|similarity_score；
 *        来源 source|doc|title（缺省空串）；
 *      全部候选都取不到 → parse 错误（端点可能不是约定的检索接口）；
 *   5. score 语义：越高越相关（0–1）；若真实服务相反，在 parse 处翻转并更新清单；
 *   6. query 中文原文直传（改写列扩展点）；
 *   7. CORS：桌面模式经宿主通道 http_post_json 规避（LLM 同处置已核实）；浏览器模式强制 mock；
 *   8. 响应 2MB 截断由宿主通道负责（topK ≤10 不会触达；触达按 parse 降级）。
 */
import type { RagCallRecord, RagChunk, RagClient, RagPort, RagQuery } from './port'
import { RagError } from './port'

/** 宿主 HTTP 通道（组合点注入），与 AgentHttpTransport 同形状 */
export type RagHttpTransport = (
  url: string,
  headers: Record<string, string>,
  body: string,
  timeoutMs: number,
) => Promise<{ status: number; body: string }>

export interface HttpRagOptions {
  baseUrl: string
  endpoint: string
  /** API 密钥：Bearer Token；空则不带 Authorization 头 */
  apiKey?: string
  /** topK 缺省值（RagQuery 未显式给 topK 时使用） */
  topK: number
  timeoutMs: number
  /** 宿主 HTTP 通道；缺省用 window.fetch（测试/浏览器调试） */
  transport?: RagHttpTransport
}

/**
 * 公网 literal IP 守卫（对齐 agent-http S-1）：知识检索的 query 含企业通信原文，
 * 篡改配置指向公网 literal IP 等价于原文外带；公网域名与内网/回环 IP 合法。
 */
function assertAllowedHost(endpoint: string): void {
  let host: string
  try {
    host = new URL(endpoint).hostname
  } catch {
    throw new RagError(`RAG 地址无法解析：${endpoint}`, 'transport')
  }
  const literal = host.replace(/^\[|\]$/g, '')
  const isIpv4 = /^\d{1,3}(\.\d{1,3}){3}$/.test(literal)
  const isIpv6 = literal.includes(':')
  if (!isIpv4 && !isIpv6) return
  const isLoopback = literal === 'localhost' || /^127\./.test(literal) || literal === '::1'
  const isPrivate =
    /^10\./.test(literal) ||
    /^192\.168\./.test(literal) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(literal) ||
    /^169\.254\./.test(literal) ||
    /^fe80:/i.test(literal) ||
    /^fc|^fd/i.test(literal)
  if (!isLoopback && !isPrivate) {
    throw new RagError(
      `RAG 地址指向公网 IP（${host}）：为防对话原文被配置篡改外带，baseUrl 请使用域名（公网/内网均可）或内网/回环 IP`,
      'transport',
    )
  }
}

/** 组装请求头与请求体（纯函数便于单测逐字段断言） */
function buildRequestParts(
  query: RagQuery,
  options: HttpRagOptions,
): { headers: Record<string, string>; body: string } {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  const apiKey = options.apiKey?.trim() ?? ''
  if (apiKey) headers.authorization = `Bearer ${apiKey}`
  const body: Record<string, unknown> = { query: query.query, top_k: query.topK ?? options.topK }
  if (query.filter?.trim()) body.filter = query.filter.trim()
  return { headers, body: JSON.stringify(body) }
}

const pickString = (record: Record<string, unknown>, keys: string[]): string => {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value.trim()) return value
  }
  return ''
}

const pickScore = (record: Record<string, unknown>): number => {
  for (const key of ['score', 'similarity', 'similarity_score']) {
    const value = record[key]
    if (typeof value === 'number' && Number.isFinite(value)) return value
  }
  return Number.NaN
}

/** 从检索响应里取片段数组（候选字段容错，[RAG-ASSUME] 4）；容器与片段字段全取不到 → null */
function pickChunks(payload: unknown): RagChunk[] | null {
  if (!payload || typeof payload !== 'object') return null
  const record = payload as Record<string, unknown>
  const list = (['results', 'chunks', 'hits', 'data'] as const)
    .map((key) => record[key])
    .find((value) => Array.isArray(value))
  if (!Array.isArray(list)) return null
  const chunks: RagChunk[] = []
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue
    const item = raw as Record<string, unknown>
    const content = pickString(item, ['content', 'text', 'chunk'])
    if (!content) continue
    const score = pickScore(item)
    chunks.push({ content, score: Number.isNaN(score) ? 0 : score, source: pickString(item, ['source', 'doc', 'title']) })
  }
  return chunks
}

interface HttpOutcome {
  status: number
  text: string
}

async function postViaFetch(url: string, headers: Record<string, string>, body: string, signal: AbortSignal): Promise<HttpOutcome> {
  const response = await fetch(url, { method: 'POST', headers, body, signal })
  return { status: response.status, text: await response.text() }
}

/** 经宿主通道发请求（abort signal 竞出 → timeout 分类），与 agent-http 同构 */
function postViaTransport(
  transport: RagHttpTransport,
  url: string,
  headers: Record<string, string>,
  body: string,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<HttpOutcome> {
  return new Promise<HttpOutcome>((resolve, reject) => {
    const onAbort = () => reject(new DOMException('已中止', 'AbortError'))
    if (signal.aborted) {
      onAbort()
      return
    }
    signal.addEventListener('abort', onAbort, { once: true })
    transport(url, headers, body, timeoutMs).then(
      (outcome) => {
        signal.removeEventListener('abort', onAbort)
        resolve({ status: outcome.status, text: outcome.body })
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      },
    )
  })
}

export function createHttpRag(options: HttpRagOptions): RagClient {
  const endpoint = `${options.baseUrl.replace(/\/+$/, '')}${options.endpoint.startsWith('/') ? '' : '/'}${options.endpoint}`
  const handlers: Array<(record: RagCallRecord) => void> = []

  const client: RagPort & Pick<RagClient, 'onCall'> = {
    onCall(handler) {
      handlers.push(handler)
    },

    async retrieve(query: RagQuery): Promise<RagChunk[]> {
      const started = Date.now()
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), options.timeoutMs)
      let record: RagCallRecord

      try {
        assertAllowedHost(endpoint)
        const { headers, body } = buildRequestParts(query, options)
        const outcome = options.transport
          ? await postViaTransport(options.transport, endpoint, headers, body, options.timeoutMs, controller.signal)
          : await postViaFetch(endpoint, headers, body, controller.signal)

        if (outcome.status < 200 || outcome.status >= 300) {
          throw new RagError(
            `RAG 返回 HTTP ${outcome.status}${outcome.text ? `：${outcome.text.slice(0, 200)}` : ''}`,
            'transport',
          )
        }
        let payload: unknown
        try {
          payload = JSON.parse(outcome.text)
        } catch {
          throw new RagError(
            'RAG 响应不是有效的 JSON（端点可能不是约定的检索接口，或响应超过宿主 2MB 上限被截断）',
            'parse',
          )
        }
        const chunks = pickChunks(payload)
        if (chunks === null) {
          throw new RagError('RAG 响应中未找到片段数组（端点可能不是约定的检索接口）', 'parse')
        }
        record = { query, chunks, latencyMs: Date.now() - started, error: '' }
        return chunks
      } catch (error) {
        const latencyMs = Date.now() - started
        const aborted = error instanceof Error && (error.name === 'AbortError' || controller.signal.aborted)
        const ragError =
          error instanceof RagError
            ? error
            : new RagError(
                aborted ? `RAG 检索超时（${options.timeoutMs}ms）` : error instanceof Error ? error.message : String(error),
                aborted ? 'transport' : error instanceof RagError ? error.kind : 'transport',
                error,
              )
        record = { query, chunks: [], latencyMs, error: ragError.message }
        throw ragError
      } finally {
        clearTimeout(timer)
        for (const handler of handlers) {
          try {
            handler(record!)
          } catch {
            // 钩子异常不影响主流程
          }
        }
      }
    },
  }

  return client as RagClient
}

/** 检索测试（设置页按钮用）：固定探测 query，返回耗时与命中摘要 */
export async function probeRagOnce(options: HttpRagOptions): Promise<{ latencyMs: number; preview: string }> {
  const client = createHttpRag(options)
  const started = Date.now()
  const chunks = await client.retrieve({ query: '连通性测试：VPN 连不上怎么处理' })
  const preview = chunks.length
    ? chunks.map((chunk) => `[${chunk.score.toFixed(2)}] ${chunk.content}`).join(' / ').slice(0, 120)
    : '（服务可达，本次零命中）'
  return { latencyMs: Date.now() - started, preview }
}
