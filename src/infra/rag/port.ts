/**
 * RAG 检索端口（设计 docs/design-welink-rag-retrieval-2026-10-05.md §6.3）。
 *
 * 最小化立场与 AgentPort 同构：**query-in / chunks-out 单接口** —— 检索服务的
 * 索引、排序、过滤语义都在服务端；调用方（pipeline）决定阈值过滤、拼装与注入。
 * 检索是「增强」不是「依赖」：失败以 RagError 分类抛出，**降级是调用方的责任**
 * （D-H：空串继续、不重试、不阻断主链路）。
 */

/** 检索命中的知识片段：content 正文；score 越高越相关（[RAG-ASSUME] 5）；source 来源标识 */
export interface RagChunk {
  content: string
  score: number
  source: string
}

/** 一次检索查询：query 为触发消息内容；filter 透传给服务端的范围过滤（[RAG-ASSUME] 3） */
export interface RagQuery {
  query: string
  filter?: string
  /** 缺省用 settings.rag.topK */
  topK?: number
}

export interface RagPort {
  retrieve(query: RagQuery): Promise<RagChunk[]>
}

/**
 * 检索错误分类：transport（网络层，大概率服务不可用）/ parse（响应形状不符，
 * 端点可能不是约定的检索接口）。分类只用于日志与调试呈现——调用方对所有类别
 * 一视同仁地降级；零命中不抛错（返回空数组，由调用方拼装为空注入）。
 */
export class RagError extends Error {
  constructor(
    message: string,
    readonly kind: 'transport' | 'parse',
    override readonly cause?: unknown,
  ) {
    super(message)
    this.name = 'RagError'
  }
}

/** 一次检索的完整记录（调试/测试用；检索结果随生成 prompt 落 R4 语料，不单独建表） */
export interface RagCallRecord {
  query: RagQuery
  chunks: RagChunk[]
  latencyMs: number
  error: string
}

export interface RagClient extends RagPort {
  /** 录音钩子：每次 retrieve 完成后调用（成功与失败都调用） */
  onCall(handler: (record: RagCallRecord) => void): void
}
