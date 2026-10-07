/**
 * Agent HTTP 实现（设计 §3.3 / §9）—— 真实对接的唯一改动面。
 *
 * 只支持一种协议：**OpenAI 兼容 chat/completions**（2026-10-04 二次决策，见
 * `docs/design-llm-connection-2026-10-02.md` §12：私有 `{prompt}→{reply}` 协议
 * 分支已随 `apiStyle` 维度一并移除，本地部署事实标准与公有云 MaaS 都是 OpenAI 形状）：
 * `POST {baseUrl}{endpoint}`，请求体
 * `{ model, messages: [{ role: 'user', content: <prompt> }], stream: false }`，
 * 响应正文取 `choices[0].message.content`（严格解析，其余字段一律视为非兼容端点）。
 *
 * [LLM-ASSUME] 已于 2026-10-04 对真实服务逐项核实并关闭（阿里云 MaaS compatible-mode，
 * curl 实测记录见 `docs/design-llm-connection-2026-10-02.md` §11）：
 *   1. 路径 `{baseUrl}{endpoint}` ✅ —— 真实服务 baseUrl 含 `/compatible-mode/v1`
 *      前缀，endpoint 配 `/chat/completions`，拼接规则无需改动；
 *   2. 鉴权 `Authorization: Bearer <apiKey>` ✅（缺头时服务端回 401「No API-key
 *      provided」，头名无误；apiKey 非空才带头）；
 *   3. `model` 必填 ✅（缺失本机 fail-fast，不发无效请求）；
 *   4. 非流式 `stream: false` ✅（一次性取全文，回复草稿要整体落库）；
 *   5. 响应 `choices[0].message.content` ✅；思考型模型（qwen3.8-flash 实测）在
 *      message 里另有 `reasoning_content` 字段 —— 只取 `content`，思考过程不会
 *      混进回复草稿；
 *   6. CORS：服务端不回 Access-Control-Allow-Origin，WebView 直发会被浏览器层
 *      拦截 —— 桌面模式经 Bridge `http_post_json`（Rust 薄通道，见
 *      `src-tauri/src/http.rs`）在宿主进程内发请求，由工厂按运行时注入
 *      `transport`（`src/infra/agent/index.ts`）；浏览器模式仍强制 mock。
 *
 * 三个必须做对的细节：
 *  * **超时必须能中止**：`AbortController` 是唯一手段，只 `Promise.race` 的话
 *    请求仍在后台跑，本地推理服务会持续占用算力；
 *  * **超时与错误分类**：`AbortError` → `timeout`，其余 → `error`（R4 语料靠这个区分）；
 *  * **onCall 恒触发**：失败也要留痕 —— 语料的价值恰恰在于「哪些提示词让模型挂了」。
 *
 * 零外联约束：只有用户自配的 `baseUrl` 会被访问（桌面模式经宿主通道发出），无遥测、
 * 无 CDN、无外部字体；API 密钥只进请求头，**绝不进日志**（工厂的 info 日志只打模型名）。
 */
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
  /** API 密钥：作 Bearer Token；空则不带 Authorization 头（本地免鉴权服务） */
  apiKey?: string
  /** 大模型名称：请求体 `model` 字段，必填（缺失 fail-fast） */
  model?: string
  /** 单次调用超时（设计 §8 默认 60s，本地推理单条可能 2–60s） */
  timeoutMs: number
  /** 宿主 HTTP 通道；缺省用 window.fetch（测试/浏览器调试） */
  transport?: AgentHttpTransport
}

/** 从 OpenAI chat/completions 响应里取回复正文（严格解析：choices[0].message.content） */
function pickReply(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null
  const choices = (payload as Record<string, unknown>).choices
  if (!Array.isArray(choices)) return null
  const first = choices[0] as Record<string, unknown> | undefined
  if (!first || typeof first.message !== 'object' || first.message === null) return null
  const content = (first.message as Record<string, unknown>).content
  return typeof content === 'string' ? content : null
}

/**
 * 公网 literal IP 守卫（质量评审 S-1）：模型服务由用户自配，公网**域名**（公有云
 * MaaS、企业网关）与内网/回环地址都是合法输入；但篡改 config.json 把 baseUrl
 * 指向一个公网 literal IP 仍等价于把含企业通信原文的 prompt 外带 —— literal
 * 公网 IP 一律拒绝并给出可行动的错误；主机名不做判定（公网模型服务走域名）。
 */
function assertAllowedHost(endpoint: string): void {
  let host: string
  try {
    host = new URL(endpoint).hostname
  } catch {
    throw new AgentError(`Agent 地址无法解析：${endpoint}`, 'error')
  }
  const literal = host.replace(/^\[|\]$/g, '') // IPv6 字面量 [::1] → ::1
  const isIpv4 = /^\d{1,3}(\.\d{1,3}){3}$/.test(literal)
  const isIpv6 = literal.includes(':')
  if (!isIpv4 && !isIpv6) return // 主机名：合法输入（公网域名/内网 DNS 均走这里）
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
      `Agent 地址指向公网 IP（${host}）：为防对话原文被配置篡改外带，baseUrl 请使用域名（公网/内网均可）或内网/回环 IP`,
      'error',
    )
  }
}

/** 组装请求头与请求体（纯函数便于单测逐字段断言），也让 complete() 的主流程保持线性 */
function buildRequestParts(
  prompt: string,
  options: HttpAgentOptions,
): { headers: Record<string, string>; body: string } {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  const apiKey = options.apiKey?.trim() ?? ''
  if (apiKey) headers.authorization = `Bearer ${apiKey}`
  return {
    headers,
    body: JSON.stringify({ model: options.model, messages: [{ role: 'user', content: prompt }], stream: false }),
  }
}

/** 单次请求的原始结果：fetch 与宿主通道统一到同一形状后再走共享的状态判定与解析 */
interface HttpOutcome {
  status: number
  text: string
}

async function postViaFetch(
  url: string,
  headers: Record<string, string>,
  body: string,
  signal: AbortSignal,
): Promise<HttpOutcome> {
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
        assertAllowedHost(endpoint)
        // model 必填：服务端只会回一个含糊的 400/404，这里提前给出可行动的错误
        // （且经 onCall 落 R4 语料，回溯里能看到原因）
        if (!options.model?.trim()) {
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

        let payload: unknown
        try {
          payload = JSON.parse(outcome.text)
        } catch {
          throw new AgentError('Agent 响应不是有效的 JSON（端点可能不是 OpenAI 兼容接口）', 'error')
        }
        const reply = pickReply(payload)
        if (reply === null) {
          throw new AgentError('Agent 响应中未找到 choices[0].message.content（端点可能不是 OpenAI 兼容接口）', 'error')
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
