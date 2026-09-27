/**
 * WeLink 端口（设计 §3.2）—— 业务层依赖的「外部世界形状」。
 *
 * 这份接口是整条链路的**变化点边界**：真实 welink-cli 文档到手后，只替换
 * `commands.ts` + `adapter.ts`（exec 是通用机制），业务层零改动（设计 §3.3）。
 *
 * 三个方法的契约要点：
 *  * `listConversations` 只用于「监控配置」的候选导入（R1），不参与常规轮询；
 *  * `pull` 的 `cursor` 对业务是**不透明的**：实现方决定语义，调用方只负责回传；
 *    `limit` 是强制的（P8：CLI 输出与 IPC 载荷都要可控），`hasMore=true` 时
 *    编排层会在同一事务内续批（≤3 次），剩余留给下一轮；
 *  * `send` 返回的 `msgUid` 是**防双发的幂等键**（回执核对用），实现必须稳定：
 *    同一内容重复发送时返回相同 uid 的实现不值得信任，真实对接务必核对。
 */
import type { NormalizedMessage, WelinkConversation, WelinkConvType } from '@/types/welink'

/** 拉取结果（分页语义：cursor 不透明，hasMore 决定是否续批） */
export interface PullResult {
  messages: NormalizedMessage[]
  cursor: string
  hasMore: boolean
}

export interface WelinkPort {
  /** R1：可选会话候选（群/联系人），供监控配置导入 */
  listConversations(): Promise<WelinkConversation[]>
  /** 增量拉取：after 为上次返回的 cursor（空串=首次） */
  pull(conv: WelinkConversation, after: string, limit: number): Promise<PullResult>
  /** 发送文本消息，返回消息唯一 ID（回执核对的幂等键） */
  send(target: { convId: string; convType: WelinkConvType }, text: string): Promise<{ msgUid: string }>
}

/**
 * 端口错误分类。
 *
 * 为什么要分类：管线对两类错误的处理**完全不同** ——
 * `transport` 值得重试（网络/进程抖动），`parse` 重试无用（协议不兼容，重试只会刷日志），
 * 而编排层的退避策略与 UI 的状态灯都依赖这个区分。
 */
export class WelinkError extends Error {
  constructor(
    message: string,
    readonly kind: 'transport' | 'parse' | 'auth' | 'unknown' = 'unknown',
    /** Error 自带 cause（ES2022），显式声明是为了在类型上暴露它 */
    override readonly cause?: unknown,
  ) {
    super(message)
    this.name = 'WelinkError'
  }
}