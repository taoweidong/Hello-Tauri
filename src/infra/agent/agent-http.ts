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
 *    [LLM-ASSUME] 对接真实大模型环境前逐一核实（同 MOCK-CLI 约定，grep "LLM-ASSUME"）：
 *      1. 路径为 `/v1/chat/completions` 类 chat/completions 端点（用户自配 endpoint）；
 *      2. 鉴权为 `Authorization: Bearer <apiKey>`（apiKey 非空才带头，本地免鉴权服务留空即可）；
 *      3. `model` 必填 —— 缺失时调用方 fail-fast 报错，不发无效请求；
 *      4. 非流式（`stream: false`），一次性取全文（回复草稿要整体落库，流式无意义）；
 *      5. 响应解析 `choices[0].message.content`（pickReply 已兼容，含 data/嵌套容错）；
 *      6. 渲染后的完整提示词作为**单条 user 消息**发送 —— 端口契约是
 *         `complete(prompt)`（D3：上下文客户端组装），拆 system/user 角色留给真实
 *         对接时按服务端要求再加，不在本期协议里预留。
 *
 * 三个必须做对的细节：
 *  * **超时必须能中止**：`AbortController` 是唯一手段，只 `Promise.race` 的话
 *    请求仍在后台跑，本地推理服务会持续占用算力；
 *  * **超时与错误分类**：`AbortError` → `timeout`，其余 → `error`（R4 语料靠这个区分）；
 *  * **onCall 恒触发**：失败也要留痕 —— 语料的价值恰恰在于「哪些提示词让模型挂了」。
 *
 * 零联网约束：只有用户自配的内网 `baseUrl` 会被访问，无遥测、无 CDN、无外部字体；
 * API 密钥只进请求头，**绝不进日志**（工厂的 info 日志只打风格/模型名）。
 */
import type { LlmApiStyle } from '@/types/welink'
import type { AgentCallRecord, AgentClient, AgentPort } from './port'
import { AgentError } from './port'

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
        const response = await fetch(endpoint, {
          method: 'POST',
          headers,
          body,
          signal: controller.signal,
        })
        const latencyMs = Date.now() - started

        if (!response.ok) {
          const detail = await response.text().catch(() => '')
          throw new AgentError(
            `Agent 返回 HTTP ${response.status}${detail ? `：${detail.slice(0, 200)}` : ''}`,
            'error',
          )
        }

        const payload = await response.json().catch(async () => ({ reply: await response.text() }))
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
