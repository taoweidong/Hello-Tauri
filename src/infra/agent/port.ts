/**
 * Agent 端口（设计 §3.2）。
 *
 * 协议极简：**prompt-in / result-out 单接口** —— 上下文由客户端组装进提示词
 * （D3），服务端无会话状态，客户端也不做多轮循环。这是刻意的最小化：
 * 内网本地部署的 SDK 服务只暴露一个「给提示词、拿回复」的入口，
 * 业务复杂度（多轮/工具调用）留在以后，不在本期协议里预留。
 */
import type { AgentLogStatus } from '@/types/welink'

/** 一次调用的完整记录（R4 落 `welink_agent_logs`） */
export interface AgentCallRecord {
  prompt: string
  response: string
  status: AgentLogStatus
  latencyMs: number
  error: string
}

export interface AgentPort {
  /** 提交完整提示词，返回回复正文；错误以 `AgentError` 分类抛出 */
  complete(prompt: string): Promise<string>
}

/**
 * Agent 错误分类。
 *
 * `timeout` 与 `error` 要分开：两者在 R4 语料里的分析价值不同
 * （超时 = 服务慢/模型卡住；错误 = 服务故障/提示词被拒），
 * 而 UI 的「错误详情」与回溯筛选都按这个分类展示。
 */
export class AgentError extends Error {
  constructor(
    message: string,
    readonly kind: 'timeout' | 'error',
    /** Error 自带 cause（ES2022），显式声明是为了在类型上暴露它 */
    override readonly cause?: unknown,
  ) {
    super(message)
    this.name = 'AgentError'
  }
}

/** Agent 客户端：端口 + 调用记录回调（onCall 让管线无需额外通道即可落 R4 语料） */
export interface AgentClient extends AgentPort {
  /** 录音钩子：每次 complete 完成后调用（成功与失败都调用，用于 1:N 留痕） */
  onCall(handler: (record: AgentCallRecord) => void): void
}
