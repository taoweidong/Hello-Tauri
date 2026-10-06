/**
 * RAG 检索 mock（[MOCK-CLI]/[MOCK-RAG] 约定：真实服务就绪前后都保留为测试
 * 替身与浏览器调试数据源）。
 *
 * 确定性命中：语料按关键词映射——query 含关键词即返回对应片段（score 递减），
 * 不含任何关键词返回空数组（演示「零命中降级」）。故障注入（failNext）供
 * 测试钉住降级路径。
 */
import type { RagCallRecord, RagChunk, RagQuery } from './port'
import { RagError, type RagClient, type RagPort } from './port'

/** 内置演示语料：关键词 → 片段列表（score 递减），浏览器演示与单测共用 */
export const MOCK_RAG_CORPUS: Record<string, Array<{ content: string; source: string }>> = {
  报错: [
    { content: '接口返回 500 时先查网关日志（运维平台 → 日志检索 → gateway），确认是上游超时还是代码异常；上游超时按「服务超时应急流程」升级。', source: 'troubleshooting.md' },
    { content: '前端报 500 但后端无日志时，优先检查请求是否被网关限流（返回头带 X-RateLimit-Exceeded）。', source: 'troubleshooting.md' },
  ],
  '500': [
    { content: '接口返回 500 时先查网关日志（运维平台 → 日志检索 → gateway），确认是上游超时还是代码异常；上游超时按「服务超时应急流程」升级。', source: 'troubleshooting.md' },
  ],
  进度: [
    { content: '发布审批进度在 OA「流程中心 → 我的申请」查看；审批卡超过 1 个工作日可@流程管理员催办。', source: 'process.md' },
  ],
  文档: [
    { content: '接口文档统一在内部 Wiki「研发 → 接口文档」栏目维护，最新版本以 Wiki 为准，聊天记录里的文档可能过期。', source: 'wiki-guide.md' },
  ],
}

export interface MockRagOptions {
  latencyMs?: number
  /** 前 N 次 retrieve 抛 transport 错（测试降级路径） */
  failures?: number
}

export interface MockRag extends RagClient {
  readonly calls: RagCallRecord[]
  reset(): void
  failNext(times?: number): void
}

export function createMockRag(options: MockRagOptions = {}): MockRag {
  const latency = options.latencyMs ?? 0
  let failures = options.failures ?? 0
  const calls: RagCallRecord[] = []
  const handlers: Array<(record: RagCallRecord) => void> = []

  const client: RagPort & Pick<RagClient, 'onCall'> = {
    onCall(handler) {
      handlers.push(handler)
    },

    async retrieve(query: RagQuery): Promise<RagChunk[]> {
      const started = Date.now()
      if (latency) await new Promise((resolve) => setTimeout(resolve, latency))
      let chunks: RagChunk[] = []
      let error = ''
      try {
        if (failures > 0) {
          failures -= 1
          throw new RagError('模拟检索服务不可用', 'transport')
        }
        const haystack = query.query
        for (const [keyword, entries] of Object.entries(MOCK_RAG_CORPUS)) {
          if (!haystack.includes(keyword)) continue
          chunks = [
            ...chunks,
            ...entries.map((entry, index) => ({
              content: entry.content,
              score: 0.9 - index * 0.1,
              source: entry.source,
            })),
          ]
        }
        return chunks      } catch (caught) {
        error = caught instanceof Error ? caught.message : String(caught)
        throw caught
      } finally {
        const record: RagCallRecord = { query, chunks, latencyMs: Date.now() - started, error }
        calls.push(record)
        for (const handler of handlers) {
          try {
            handler(record)
          } catch {
            // 钩子异常不影响主流程
          }
        }
      }
    },
  }

  return {
    ...client,
    calls,
    reset() {
      calls.length = 0
      failures = options.failures ?? 0
    },
    failNext(times = 1) {
      failures = times
    },
  } as MockRag
}
