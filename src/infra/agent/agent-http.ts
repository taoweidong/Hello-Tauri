/**
 * Agent HTTP 实现（设计 §3.3 / §9）—— 真实对接的唯一改动面。
 *
 * 协议假设（文档到手后改这里）：`POST {baseUrl}{endpoint}`，请求体
 * `{ prompt: string }`，响应体 `{ reply: string }`（字段名容错见下）。
 *
 * 三个必须做对的细节：
 *  * **超时必须能中止**：`AbortController` 是唯一手段，只 `Promise.race` 的话
 *    请求仍在后台跑，本地推理服务会持续占用算力；
 *  * **超时与错误分类**：`AbortError` → `timeout`，其余 → `error`（R4 语料靠这个区分）；
 *  * **onCall 恒触发**：失败也要留痕 —— 语料的价值恰恰在于「哪些提示词让模型挂了」。
 *
 * 零联网约束：只有用户自配的内网 `baseUrl` 会被访问，无遥测、无 CDN、无外部字体。
 */
import type { AgentCallRecord, AgentClient, AgentPort } from './port'
import { AgentError } from './port'

export interface HttpAgentOptions {
  baseUrl: string
  endpoint: string
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
        const response = await fetch(endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ prompt }),
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