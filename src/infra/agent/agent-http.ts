/**
 * Agent HTTP 实现（设计 §3.3 / §9）—— 真实对接的唯一改动面。
 *
 * 两种接口风格（`apiStyle`，见 `LlmApiStyle`）：
 *
 *  * `simple` —— 内网 SDK 私有协议（设计 §3.2/D3）：
 *    `POST {baseUrl}{endpoint}`，请求体 `{ prompt }`，响应体 `{ reply }`
 *    （字段名容错见 pickReply）。
 *
 *  * `openai` —— OpenAI 兼容 chat/completions（内网本地部署的事实标准）：
 *    `POST {baseUrl}{endpoint}`，请求体
 *    `{ model, messages: [{ role: 'user', content: <prompt> }], stream: false }`，
 *    响应正文取 `choices[0].message.content`。
 *    [LLM-ASSUME] 已于 2026-10-04 对真实服务逐项核实（阿里云 MaaS compatible-mode，
 *    OpenAI 兼容端点；curl 实测记录见 `docs/design-llm-connection-2026-10-02.md` §11）：
 *      1. 路径 `{baseUrl}{endpoint}` ✅ —— 真实服务 baseUrl 含 `/compatible-mode/v1`
 *         前缀，endpoint 配 `/chat/completions`，拼接规则无需改动；
 *      2. 鉴权 `Authorization: Bearer <apiKey>` ✅（缺头时服务端回 401「No API-key
 *         provided」，头名无误；apiKey 非空才带头）；
 *      3. `model` 必填 ✅（服务端经 GET /models 提供模型清单；缺失仍按 D-D 本机
 *         fail-fast，不依赖服务端含糊的 400）；
 *      4. 非流式 `stream: false` ✅（一次性取全文，回复草稿要整体落库）；
 *      5. 响应 `choices[0].message.content` ✅；思考型模型（qwen3.8-flash 实测）在
 *         message 里另有 `reasoning_content` 字段 —— pickReply 的候选键不含它，
 *         只会命中 `content`，思考过程不会混进回复草稿；
 *      6. **CORS 假设不成立**（设计 §7 预判的最大风险点）：服务端不回
 *         Access-Control-Allow-Origin（预检 401），WebView 直发 `window.fetch` 会被
 *         浏览器层拦截 —— 桌面模式经 Bridge `http_post_json`（Rust 薄通道，见
 *         `src-tauri/src/http.rs`）在宿主进程内发请求，由工厂按运行时注入
 *         `transport`（`src/infra/agent/index.ts`）；浏览器模式仍强制 mock，
 *         不发真实请求。
 *
 * 三个必须做对的细节：
 *  * **超时必须能中止**：`AbortController` 是唯一手段，只 `Promise.race` 的话
 *    请求仍在后台跑，本地推理服务会持续占用算力；
 *  * **超时与错误分类**：`AbortError` → `timeout`，其余 → `error`（R4 语料靠这个区分）；
 *  * **onCall 恒触发**：失败也要留痕 —— 语料的价值恰恰在于「哪些提示词让模型挂了」。
 *
 * 零外联约束：只有用户自配的 `baseUrl` 会被访问（桌面模式经宿主通道发出），无遥测、
 * 无 CDN、无外部字体；API 密钥只进请求头，**绝不进日志**（工厂的 info 日志只打风格/模型名）。
 */
import type { LlmApiStyle } from '@/types/welink'
import type { AgentCallRecord, AgentClient, AgentPort } from './port'
import { AgentError } from './port'

/**
 * 宿主 HTTP 通道（组合点注入）：桌面模式的 WebView 直发会被大模型服务的
 * CORS 缺失拦截，由工厂（index.ts）注入经 Bridge `http_post_json` 走 Rust 的
 * 实现；浏览器模式强制 mock 不注入，测试默认走 window.fetch。
 */
export type AgentHttpTransport = (
  url: string,
  headers: Record<string, string>,
  body: string,
  timeoutMs: number,
) => Promise<{ status: number; body: string }>

export interface HttpAgentOptions {
  baseUrl: string
  endpoint: string
  /** 接口风格；缺省按 simple（私有 prompt-in/result-out 协议） */
  apiStyle?: LlmApiStyle
  /** API 密钥：openai 风格作 Bearer Token；空则不带 Authorization 头 */
  apiKey?: string
  /** 大模型名称：openai 风格必填（缺失 fail-fast），simple 风格忽略 */
  model?: string
  /** 单次调用超时（设计 §8 默认 60s，本地推理单条可能 2–60s） */
  timeoutMs: number
  /** 宿主 HTTP 通道；缺省用 window.fetch（测试/浏览器调试） */
  transport?: AgentHttpTransport
}

/** 从响应体里取回复正文（字段名容错：真实服务的字段名未知） */
function pickReply(payload: unknown): string | null {
  if (typeof payload === 'string') return payload
  if (!payload || typeof payload !== 'object') return null
  const record = payload as Record<string, unknown>
  for (const key of ['reply', 'response', 'result', 'text', 'content', 'answer', 'output', 'message']) {
    const value = record[key]
    if (typeof value === 'string') return value
  }
  // 某些服务把正文包在 data/choices 里
  const nested = record.data ?? record.result
  if (nested && typeof nested === 'object' && nested !== payload) return pickReply(nested)
  if (Array.isArray(record.choices)) {
    const first = record.choices[0] as Record<string, unknown> | undefined
    if (first) return pickReply(first.message ?? first.text ?? first)
  }
  return null
}

/**
 * 内网约束守卫（质量评审 S-1）：Agent 是「内网本地部署的 SDK 服务」（设计 §1）。
 * 篡改 config.json 把 baseUrl 指向公网 literal IP，等于把含企业通信原文的
 * prompt 外带出去 —— literal 公网 IP 一律拒绝并给出可行动的错误；主机名不做
 * 判定（内网 DNS 无法在客户端分类），确有特殊部署场景时用域名即可通过。
 */
function assertIntranetHost(endpoint: string): void {
  let host: string
  try {
    host = new URL(endpoint).hostname
  } catch {
    throw new AgentError(`Agent 地址无法解析：${endpoint}`, 'error')
  }
  const literal = host.replace(/^\[|\]$/g, '') // IPv6 字面量 [::1] → ::1
  const isIpv4 = /^\d{1,3}(\.\d{1,3}){3}$/.test(literal)
  const isIpv6 = literal.includes(':')
  if (!isIpv4 && !isIpv6) return // 主机名：交给 DNS/内网语义
  const isLoopback = literal === 'localhost' || /^127\./.test(literal) || literal === '::1'
  const isPrivate =
    /^10\./.test(literal) ||
    /^192\.168\./.test(literal) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(literal) ||
    /^169\.254\./.test(literal) ||
    /^fe80:/i.test(literal) ||
    /^fc|^fd/i.test(literal) // IPv6 unique local（fc00::/7）
  if (!isLoopback && !isPrivate) {
    throw new AgentError(
      `Agent 地址指向公网（${host}）：本应用面向内网部署，拒绝把对话内容发往公网地址。请改为内网 IP 或主机名`,
      'error',
    )
  }
}

/**
 * 按接口风格组装请求头与请求体。
 *
 * 拆成纯函数便于单测逐字段断言（openai 的 model/messages/鉴权头、simple 的
 * 最小 `{ prompt }` 协议），也让 complete() 的主流程保持线性。
 */
function buildRequestParts(prompt: string, options: HttpAgentOptions): { headers: Record<string, string>; body: string } {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (options.apiStyle === 'openai') {
    const apiKey = options.apiKey?.trim() ?? ''
    if (apiKey) headers.authorization = `Bearer ${apiKey}`
    return { headers, body: JSON.stringify({ model: options.model, messages: [{ role: 'user', content: prompt }], stream: false }) }
  }
  return { headers, body: JSON.stringify({ prompt }) }
}

/** 单次请求的原始结果：fetch 与宿主通道统一到同一形状后再走共享的状态判定与解析 */
interface HttpOutcome {
  status: number
  text: string
}

async function postViaFetch(url: string, headers: Record<string, string>, body: string, signal: AbortSignal): Promise<HttpOutcome> {
  const response = await fetch(url, { method: 'POST', headers, body, signal })
  return { status: response.status, text: await response.text() }
}

/**
 * 经宿主通道发请求。超时由 complete() 的 timer 触发 abort signal：
 * 监听器立刻以 AbortError 竞出（→ timeout 分类）；宿主侧另带同值超时兜底，
 * 即便 TS 层已放弃，Rust 侧的请求也不会无限期占用连接。
 */
function postViaTransport(
  transport: AgentHttpTransport,
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

export function createHttpAgent(options: HttpAgentOptions): AgentClient {
  const endpoint = `${options.baseUrl.replace(/\/+$/, '')}${options.endpoint.startsWith('/') ? '' : '/'}${options.endpoint}`
  const handlers: Array<(record: AgentCallRecord) => void> = []

  const client: AgentPort & Pick<AgentClient, 'onCall'> = {
    onCall(handler) {
      handlers.push(handler)
    },

    async complete(prompt: string): Promise<string> {
      const started = Date.now()
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), options.timeoutMs)
      let record: AgentCallRecord

      try {
        assertIntranetHost(endpoint)
        // openai 风格 model 必填：服务端只会回一个含糊的 400/404，这里提前给出
        // 可行动的错误（且经 onCall 落 R4 语料，回溯里能看到原因）
        if (options.apiStyle === 'openai' && !options.model?.trim()) {
          throw new AgentError('OpenAI 兼容接口需要在设置里填写「大模型名称」（model）', 'error')
        }
        const { headers, body } = buildRequestParts(prompt, options)
        const outcome = options.transport
          ? await postViaTransport(options.transport, endpoint, headers, body, options.timeoutMs, controller.signal)
          : await postViaFetch(endpoint, headers, body, controller.signal)
        const latencyMs = Date.now() - started

        if (outcome.status < 200 || outcome.status >= 300) {
          throw new AgentError(
            `Agent 返回 HTTP ${outcome.status}${outcome.text ? `：${outcome.text.slice(0, 200)}` : ''}`,
            'error',
          )
        }

        // 先取全文再解析：非 JSON 响应兜底为 { reply: 全文 }（与 response.json()
        // 失败后回读 text 的旧兜底等价，且不依赖「json() 失败后还能再读 body」）
        let payload: unknown
        try {
          payload = JSON.parse(outcome.text)
        } catch {
          payload = { reply: outcome.text }
        }
        const reply = pickReply(payload)
        if (reply === null) {
          throw new AgentError('Agent 响应中未找到回复正文字段', 'error')
        }
        record = { prompt, response: reply, status: 'ok', latencyMs, error: '' }
        return reply
      } catch (error) {
        const latencyMs = Date.now() - started
        const aborted = error instanceof Error && (error.name === 'AbortError' || controller.signal.aborted)
        const agentError =
          error instanceof AgentError
            ? error
            : new AgentError(
                aborted
                  ? `Agent 调用超时（${options.timeoutMs}ms）`
                  : error instanceof Error
                    ? error.message
                    : String(error),
                aborted ? 'timeout' : 'error',
                error,
              )
        record = {
          prompt,
          response: '',
          status: agentError.kind === 'timeout' ? 'timeout' : 'error',
          latencyMs,
          error: agentError.message,
        }
        throw agentError
      } finally {
        clearTimeout(timer)
        // onCall 恒触发：成功与失败都要落 R4 语料（失败样本正是改进提示词的依据）
        for (const handler of handlers) {
          try {
            handler(record!)
          } catch {
            // 录音钩子自身异常不能影响业务主流程
          }
        }
      }
    },
  }

  return client as AgentClient
}

/** 连通性测试（Settings 的按钮用）：发一个固定探测 prompt，返回耗时与摘要 */
export async function probeAgent(options: HttpAgentOptions): Promise<{ latencyMs: number; preview: string }> {
  const client = createHttpAgent(options)
  const started = Date.now()
  const reply = await client.complete('连通性测试：请只回复「ok」两个字符。')
  return { latencyMs: Date.now() - started, preview: reply.slice(0, 120) }
}

export type { AgentPort }
