/**
 * Agent Mock（设计 §3.3）。
 *
 * 目的：真实模型服务未接入（或无模型环境）时，让「生成草稿」这段链路可跑、可测、可演示。
 *
 * 两个设计要点：
 *  * **确定性**：回复模板由提示词内容推导（不是随机），失败注入用固定种子 ——
 *    测试与演示的可重复性优先于「像真的」；随机行为会让 CI 随机变红。
 *  * **失败可控**：`failures` 计数与 `latencyMs` 可注入，用于覆盖管线的
 *    重试 / attempts 耗尽 / 时间线展示（超时分支尤其要靠它）。
 */
import type { AgentCallRecord, AgentClient } from './port'
import { AgentError } from './port'
import { sanitizeReply } from './prompt'

export interface MockAgentOptions {
  /** 每批固定延迟（毫秒）。真实本地推理 2–60s，演示时给 1–2s 即可看出「异步不卡 UI」 */
  latencyMs?: number
  /** 前 N 次调用抛错（覆盖重试与耗尽分支） */
  failures?: number
  /** 前 N 次调用超时（覆盖 timeout 分类与 UI 状态） */
  timeouts?: number
  /** 回复模板：`{{sender}}`/`{{question}}` 仍会被替换，便于断言 |
   *  传函数则可完全自定义（测试断言模型「换答」场景） */
  template?: string | ((prompt: string) => string)
}

export interface MockAgent extends AgentClient {
  /** 已发生的调用（断言「调了几次、prompt 长什么样」） */
  readonly calls: AgentCallRecord[]
  reset(): void
  /** 注入后续调用失败 */
  failNext(times?: number): void
}

/** 默认模板：把提示词里的关键片段提炼成一句人话，让 mock 输出看起来像真回复 */
const DEFAULT_TEMPLATE = (prompt: string): string => {
  const question = /【需要回复的消息】\s*\n([\s\S]*)$/.exec(prompt)?.[1]?.trim() ?? ''
  const sender = /【对方】\s*(.+)/.exec(prompt)?.[1]?.trim() ?? '对方'
  if (!question) return '收到，我看一下，稍后回复你。'
  if (/报\s*500|报错|异常|故障|挂了|不可用/.test(question)) {
    return `收到，${sender}。我先查一下${/生产/.test(question) ? '生产环境' : ''}的日志，定位到原因后同步给你。`
  }
  if (/进度|什么时候|多久|时间点|ddl/i.test(question)) {
    return `收到，我这边的进度整理一下，今天下班前给你一个明确的说法。`
  }
  if (/文档|材料|方案|清单|表格/.test(question)) {
    return `好的，我整理一份发你，稍等。`
  }
  if (/@所有人|例会|会议|周会/.test(question)) {
    return '收到。'
  }
  return `收到，${sender}，我看一下，稍后回复。`
}

export function createMockAgent(options: MockAgentOptions = {}): MockAgent {
  const latencyMs = options.latencyMs ?? 0
  let failures = options.failures ?? 0
  let timeouts = options.timeouts ?? 0
  const calls: AgentCallRecord[] = []
  const handlers: Array<(record: AgentCallRecord) => void> = []

  const render = (prompt: string): string => {
    if (typeof options.template === 'function') return options.template(prompt)
    if (typeof options.template === 'string') {
      const question = /【需要回复的消息】\s*\n([\s\S]*)$/.exec(prompt)?.[1]?.trim() ?? ''
      const sender = /【对方】\s*(.+)/.exec(prompt)?.[1]?.trim() ?? '对方'
      return options.template.replaceAll('{{question}}', question).replaceAll('{{sender}}', sender)
    }
    return DEFAULT_TEMPLATE(prompt)
  }

  return {
    get calls() {
      return calls
    },

    reset() {
      calls.length = 0
      failures = 0
      timeouts = 0
    },

    failNext(times = 1) {
      failures = times
    },

    onCall(handler) {
      handlers.push(handler)
    },

    async complete(prompt: string): Promise<string> {
      const started = Date.now()
      if (latencyMs > 0) await new Promise((resolve) => setTimeout(resolve, latencyMs))

      let record: AgentCallRecord
      try {
        if (timeouts > 0) {
          timeouts -= 1
          throw new AgentError('mock：模拟 Agent 超时', 'timeout')
        }
        if (failures > 0) {
          failures -= 1
          throw new AgentError('mock：模拟 Agent 服务错误', 'error')
        }
        const reply = sanitizeReply(render(prompt))
        record = { prompt, response: reply, status: 'ok', latencyMs: Date.now() - started, error: '' }
        calls.push(record)
        return reply
      } catch (error) {
        const agentError = error instanceof AgentError ? error : new AgentError(String(error), 'error')
        record = {
          prompt,
          response: '',
          status: agentError.kind === 'timeout' ? 'timeout' : 'error',
          latencyMs: Date.now() - started,
          error: agentError.message,
        }
        calls.push(record)
        throw agentError
      } finally {
        for (const handler of handlers) {
          try {
            handler(record!)
          } catch {
            // 录音失败不影响主流程
          }
        }
      }
    },
  }
}
