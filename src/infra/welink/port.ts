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
import type { NormalizedAnnouncement, NormalizedMessage, WelinkConversation, WelinkConvType } from '@/types/welink'

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
  /**
   * 可选能力：拉取群公告（knowledge-sedimentation K-C 打桩先行）。公告此前无任何
   * 抓取/存储（normalize 阶段 system 类正文被占位符丢弃），本方法是其数据入口。
   *
   * 实现方无此能力时**不实现本方法**（调用方以 `'pullAnnouncements' in port` 判定），
   * 调用侧必须诚实降级：跳过公告采集并留运行日志，SHALL NOT 因此失败整轮沉淀。
   *
   * [CLI-ASSUME] 公告抓取协议未核实：welink-cli 是否有公告子命令、子命令名/参数/
   * 字段名（标题/正文/发布时间/ann_uid）/编码/分页均待对接期按
   * `docs/cli-integration-adaptation-2026-10-04.md` §SOP 逐项核实，核实后更新本
   * 注释并实现 cli 适配器；mock 适配器返回确定性样例（供演示与测试）。
   */
  pullAnnouncements?(conv: WelinkConversation, limit: number): Promise<NormalizedAnnouncement[]>
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

/**
 * 建群端口：welink-cli 的「快速建群」能力（migration v3）。
 *
 * 与消息三方法分开成端口，是因为两者的**重试语义相反**：list/pull 的传输故障
 * 值得重试 1 次（幂等读），而建群**绝不能自动重试** —— CLI 可能已经把群建成功
 * 只是响应丢了，重试会拉出两个一样的群。失败就落 failed 留痕，由人决定是否再建。
 */
export interface GroupPort {
  /** 创建群聊，返回新群的会话 ID（写进建群历史，供后续追溯） */
  createGroup(input: { name: string; memberIds: string[] }): Promise<{ groupId: string }>
}
