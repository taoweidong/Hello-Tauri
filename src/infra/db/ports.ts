/**
 * 数据层端口契约（设计 §3.1：`infra/db` 对上只暴露类型化方法）。
 *
 * 上层（orchestrator/store/UI）**只看到 Promise 化的类型 API** —— SQL 文本、参数绑定、
 * 事务边界、迁移注册、保留期清理全部封在实现里。
 *
 * 两条硬约束（改动时勿破坏）：
 *  1. **分页强制**（设计 §5-P7）：所有列表查询的签名都带 `limit`，实现内部必须拼
 *     `LIMIT`。禁止无 limit 的全表 SELECT —— 这是本项目唯一的大列表防线。
 *  2. **状态机原子性**（要点3）：`commitDraft` 必须在**同一条 UPDATE** 里写 draft 与
 *     `status='ready'`；`markSent` 必须在同一事务里写 sent 并回写 out 消息（防双发）。
 */
import type {
  HoldReason,
  JobRating,
  JobStatus,
  MessageDirection,
  NormalizedMessage,
  SkillSource,
  SkipReason,
  TriggerType,
  WelinkAgentLog,
  WelinkConvType,
  WelinkConversation,
  WelinkJob,
  WelinkMessage,
} from '@/types/welink'

/** 入库结果：本批真正新增的消息（幂等去重后），供 store 增量打补丁（P5） */
export interface ApplyResult {
  /** 新增消息（含其落库主键），已去重；本批全部重复时为空数组 */
  inserted: WelinkMessage[]
  /** 命中回复规则、本次新建的回复任务 */
  createdJobs: WelinkJob[]
  /** 推进后的游标 */
  cursor: string
}

/** 消息流分页查询条件 */
export interface MessageQuery {
  convPk: number
  /** 只取早于该时间的消息（向上翻页游标）；不传=最新 */
  before?: string
  keyword?: string
  /** 强制分页（P7）：必须传，仓储层不提供无 limit 的查询 */
  limit: number
}

/** 回复历史分页查询条件（R3） */
export interface JobQuery {
  status?: JobStatus[]
  triggerType?: TriggerType[]
  targetId?: string
  /** 只看被 Gate 拦下的（`skip_reason != ''`） */
  onlySkipped?: boolean
  /** 只看待我处理（`hold_reason != ''` 且 ready，O7） */
  onlyHolding?: boolean
  /** 只看差评（O10） */
  onlyDownRated?: boolean
  from?: string
  to?: string
  limit: number
  offset: number
}

/** 回复历史统计条（R3 仪表盘） */
export interface JobStats {
  todayCount: number
  sentCount: number
  failedCount: number
  /** 成功率 = sent / (sent + failed + skipped 之外的实际外发尝试) */
  successRate: number
  avgLatencySec: number
  skippedCount: number
}

/** 收件箱联系人分组（R2） */
export interface InboxThread {
  convPk: number
  convId: string
  title: string
  unreadCount: number
  lastMsgAt: string
  /** 最后一条 in 消息内容（列表摘要） */
  lastContent: string
}

export interface InboxQuery {
  /** 时间段（默认最近 30 天） */
  from?: string
  to?: string
  /** 只看未回复（该会话存在未终态 job） */
  onlyUnreplied?: boolean
  keyword?: string
  limit: number
  offset: number
}

/** 会话 CRUD 的写入草稿 */
export interface ConversationDraft {
  convType: WelinkConvType
  convId: string
  title?: string
  remark?: string
  watching?: boolean
  autoReply?: boolean
}

/** 新建回复任务（与消息入库同事务，设计 §6.1） */
export interface JobDraft {
  triggerMsgPk: number
  /**
   * 触发消息的幂等键。跨重启恢复（§6.3 三分支）与手工补建任务都要靠它把
   * 「消息」与「任务」重新对上 —— 主键在重启后不一定还能引用到同一行。
   */
  triggerMsgUid: string
  triggerType: TriggerType
  targetType: WelinkConvType
  targetId: string
  sendModeUsed: 'auto' | 'manual'
  contextSnapshot: string
}

/**
 * 草稿提交时一并留痕的技能归属（skill-routing D5）。
 *
 * `name` 是快照：技能后续改名/删除，历史任务展示不变脸；
 * 无外键 —— 技能配置存 config.json，SQLite 不建技能表。
 */
export interface SkillAttribution {
  id: string
  name: string
  source: SkillSource
}

/** 一轮拉取的入库参数（`triggers` 由编排层按 §7.1 规则计算） */
export interface ApplyRules {
  /** msgUid → 该消息命中的触发类型；未命中不在此表 */
  triggers: Record<string, TriggerType>
  /** 自动回复开关快照（决定新 job 的 send_mode_used） */
  sendMode: 'auto' | 'manual'
  /** 提示词模板（用于生成 context_snapshot 占位；为空则不存快照） */
  keepSnapshot?: boolean
}

/** 分页强制（P7）的例外上限 —— 见 `listWatching` / `listUnfinishedJobs` 的说明 */
export const WATCHING_HARD_LIMIT = 1000
export const UNFINISHED_HARD_LIMIT = 2000

/**
 * 会话管理页一次读取的条数（D-5）。真值已迁 `@/types/welink`（展示常量归
 * types 层，quality-hardening-2026-10 D2），此处 re-export 保持 infra 内部与
 * 既有引用方的兼容。
 */
export { CONVERSATION_PAGE_LIMIT } from '@/types/welink'

/** 消息保留期（天）。设计 §8：仓储层常量，清理任务按天分批删除 */
export const RETENTION_KEEP_DAYS = 180

/**
 * Agent 语料保留期（天）。
 *
 * 为什么比消息短：`welink_agent_logs` 存的是**完整提示词**（含最近对话原文）
 * 与模型回复，隐私敏感度高于消息存档本身（R4 的语料是「为了改进提示词」，
 * 不需要长期沉淀）。设计 §10 只要求「提供清理入口」，这里进一步给出自动过期，
 * 把「靠人记得点清理」变成默认安全。
 */
export const AGENT_LOG_KEEP_DAYS = 90

/** 保留期清理的批大小（设计 §5-P1：大事务分批 ≤500 行，由调用方循环） */
export const PURGE_BATCH_SIZE = 500

export interface WelinkRepository {
  // —— 会话（R1 / L3 / O11） ——
  /** 全量会话（分页强制，P7） */
  listConversations(limit: number, offset: number): Promise<WelinkConversation[]>
  /** 会话总数（不触表数据，用于分页脚） */
  countConversations(): Promise<number>
  /**
   * 仅监控中的会话（poller 的数据源）。
   *
   * **P7 的受控例外**：这是**调度输入集**而非展示列表 —— 分页会让轮询逻辑变成
   * 「翻页拉取」这种既有状态又有顺序的复杂度，而监控清单本身是人工白名单（量级
   * 是十几到几十个）。因此不暴露分页参数，但 SQL 仍带 `WATCHING_HARD_LIMIT`，
   * 保证任何情况下都不会出现「无 LIMIT 的全表 SELECT」。
   */
  listWatching(): Promise<WelinkConversation[]>
  getConversation(convId: string): Promise<WelinkConversation | null>
  /** 新增或按 convId 覆盖（CLI 同步导入用：已有项不覆盖 watching/auto_reply） */
  upsertConversation(draft: ConversationDraft): Promise<WelinkConversation>
  updateConversation(
    convId: string,
    patch: Partial<Pick<WelinkConversation, 'title' | 'remark' | 'watching' | 'autoReply' | 'muteUntil'>>,
  ): Promise<void>
  /** 批量开/关自动回复（v4.2 批量操作） */
  setAutoReply(convIds: string[], enabled: boolean): Promise<number>
  /** 删除会话（级联删 messages/jobs，调用方须二次确认） */
  removeConversation(convId: string): Promise<void>

  // —— 消息（要点1/2 + O3 汇总列维护） ——
  /**
   * 按主键取单条消息。
   *
   * 用途是「从 job 反查触发消息」——外发闸口的 S5（同人短窗合并）需要触发消息的
   * 发送者工号，而 job 只存了 `trigger_msg_pk`。单行主键查询，不受 P7 分页约束。
   */
  getMessage(pk: number): Promise<WelinkMessage | null>
  /**
   * 单事务应用一轮拉取结果（P4）：
   * 幂等批写 messages + 推进 cursor + 建 reply_job + 维护汇总列（unread/mention/last_msg_at/last_active）。
   *
   * **触发策略不进数据层**：编排层按 §7.1 规则算好 `triggers`（msgUid → 触发类型）后传入，
   * 仓储只负责「有触发就建 job」。这样触发规则可以在编排层单测，仓储保持纯数据操作。
   */
  applyPollResult(
    convId: string,
    messages: NormalizedMessage[],
    cursor: string,
    rules: ApplyRules,
  ): Promise<ApplyResult>
  /** 消息流分页（P7；`before` 向上翻页） */
  listMessages(query: MessageQuery): Promise<WelinkMessage[]>
  /** 关键词 + 时间段搜索（O12，LIKE + 分页，不引 FTS5） */
  searchMessages(
    keyword: string,
    from: string | undefined,
    to: string | undefined,
    limit: number,
    offset: number,
  ): Promise<WelinkMessage[]>
  /** 打开会话即批量已读：同事务置 read_flag=1 并把 unread/mention 清零（O6） */
  markRead(convPk: number): Promise<void>
  /** 该会话最近 N 条消息（组装提示词上下文用，倒序取后正序返回） */
  recentContext(convPk: number, maxN: number): Promise<WelinkMessage[]>
  /** 私聊收件箱分组（R2） */
  listInbox(query: InboxQuery): Promise<InboxThread[]>
  countInbox(query: Omit<InboxQuery, 'limit' | 'offset'>): Promise<number>

  // —— 回复任务（要点3 + 状态机 §7.3） ——
  createJob(draft: JobDraft): Promise<WelinkJob>
  getJob(pk: number): Promise<WelinkJob | null>
  /** 按状态取一批（worker 出队；不传状态=全部未终态） */
  listJobsByStatus(status: JobStatus[], limit: number): Promise<WelinkJob[]>
  /**
   * 启动恢复：全部未终态 job（§6.3）。
   *
   * **P7 的受控例外**，理由同 `listWatching`：这是启动恢复的**工作集**，
   * 不是展示列表。正常运行时未终态任务会被当场消费掉，积压量取决于崩溃前
   * 的在途任务数（远小于总量）；SQL 带 `UNFINISHED_HARD_LIMIT` 兜底防呆，
   * 超出的部分由下一轮恢复接手。
   */
  listUnfinishedJobs(): Promise<WelinkJob[]>
  /** 回复历史分页（R3）+ 筛选 */
  listJobs(query: JobQuery): Promise<WelinkJob[]>
  countJobs(query: Omit<JobQuery, 'limit' | 'offset'>): Promise<number>
  /** 统计条（R3） */
  jobStats(dayStart: string, hourStart: string): Promise<JobStats>
  /** 状态流转（乐观并发：`expect` 不匹配则不动，返回是否生效） */
  markStatus(pk: number, status: JobStatus, expect?: JobStatus): Promise<boolean>
  /**
   * 要点3 的原子保证：draft 与 status='ready' **同一条 UPDATE**。
   * `skill` 传入时技能三列与草稿同条写入（skill-routing：分类结果与草稿原子落库）。
   * 返回是否生效（同一 job 被并发处理时后写者不得覆盖）。
   */
  commitDraft(pk: number, draft: string, contextSnapshot?: string, skill?: SkillAttribution): Promise<boolean>
  /** 生成失败：attempts++ 与错误留痕（未耗尽时回 pending 由 worker 重试） */
  recordAttemptFailure(pk: number, status: JobStatus, error: string): Promise<void>
  /** 重发：failed → ready 入队（UI 手动重发） */
  requeueJob(pk: number): Promise<boolean>
  /** Gate 拦截：status='skipped' + skip_reason 同条 UPDATE 留痕（§5A） */
  skipJob(pk: number, reason: SkipReason | string): Promise<void>
  /** 转人工待审：停 ready + hold_reason（计入 reviewCount，O7） */
  holdJob(pk: number, reason: HoldReason | string): Promise<void>
  /** 挂起（静默时段/全局配额）：回 ready 但不带 hold_reason，等待下一轮外发 */
  suspendJob(pk: number): Promise<void>
  /** 人工编辑草稿（UI 编辑并发送）：覆盖 draft 并置 ready */
  updateDraft(pk: number, draft: string): Promise<void>
  /** 人工评价（O10） */
  rateJob(pk: number, rating: JobRating | null): Promise<void>
  /**
   * 删除单条回复任务记录（§11.3 行操作）。
   *
   * 语义刻意窄：**只删 job 行与其 agent 留痕，不动触发消息与会话** ——
   * 「回复记录错了」和「这条收到的消息不该存在」是两件事，混在一起删会让
   * 消息存档出现无法解释的空洞。需要删存档请走 `removeConversation`（带级联确认）。
   */
  removeJob(pk: number): Promise<boolean>
  /**
   * 发送成功：**单事务**写 `sent + finished_at` 并回写 out 消息（同 msg_uid 幂等）。
   * 返回是否由本次调用完成（已被并发写成 sent 时返回 false，防双发记账重复）。
   */
  markSent(pk: number, receipt: { msgUid: string; sentAt: string; convPk: number; content: string }): Promise<boolean>
  /** 重发前的回执核对：该 job 对应的 out 消息是否已落库（§6.2/§6.3 防双发） */
  hasOutgoingReceipt(pk: number): Promise<boolean>
  /** 待审数量（O7：hold_reason != '' 的 ready job 数） */
  countHolding(): Promise<number>
  /** 本小时某会话已发送条数（Gate 会话配额预取，O5 缓存初始值） */
  countSentSince(targetId: string, since: string): Promise<number>
  /**
   * 该会话最后一次**成功外发**的时刻（无记录返回 null）。
   *
   * 为什么单列一个方法：S1 的「最小回复间隔」是**跨重启仍然成立**的硬约束
   * （设计 §5A.2 允许 S2/S3 计数重启清零，但「刚回复过就重启再回复」显然不合规），
   * 因此 Gate 初始化内存缓存时必须能从库中恢复这个基线（O5）。
   */
  lastSentAt(targetId: string): Promise<string | null>
  /** 本小时全局已发送条数（Gate 全局配额预取） */
  countGlobalSentSince(since: string): Promise<number>

  // —— Agent 调用留痕（R4） ——
  insertAgentLog(log: {
    jobPk: number
    prompt: string
    response: string
    status: WelinkAgentLog['status']
    latencyMs: number
    error: string
  }): Promise<WelinkAgentLog>
  listAgentLogs(jobPk: number): Promise<WelinkAgentLog[]>
  /** 回溯 Tab 的 job 列表（分页强制） */
  listJobsWithLogs(limit: number, offset: number, onlyDownRated: boolean): Promise<WelinkJob[]>
  /** 与 `listJobsWithLogs` 配对的计数（分页脚必须与列表同口径，否则数字对不上） */
  countJobsWithLogs(onlyDownRated: boolean): Promise<number>
  /** 清理回溯记录（设计 §10：语料含敏感对话，提供清理入口） */
  clearAgentLogs(jobPk: number): Promise<number>

  // —— 维护 ——
  /** 保留期清理：按批次删除过期消息（P1：每批 ≤500 行，由调用方循环） */
  purgeMessagesBefore(cutoff: string, batch: number): Promise<number>
  /**
   * 保留期清理：按批次删除过期 Agent 语料（与消息同构，按 `created_at` 过期）。
   *
   * 语义边界：**只删留痕，不动 job**。job 是回复历史的主体，语料只是它的调试
   * 附件 —— 把 job 一起删会让「某天回复了多少条」这类统计凭空缩水。
   */
  purgeAgentLogsBefore(cutoff: string, batch: number): Promise<number>
  /** 该会话是否存在历史消息（删除会话时二次确认的依据） */
  countMessages(convPk: number): Promise<number>
  /** 未回复计数（收件箱筛选辅助） */
  countUnrepliedThreads(): Promise<number>
}

/** 消息方向文案（UI 与提示词共用） */
export const DIRECTION_LABEL: Record<MessageDirection, string> = { in: '收到', out: '发出' }

// 状态机文案 / 配色 / 拦截与待审原因说明：真值已迁 `@/types/welink`
// （展示常量归 types 层，quality-hardening-2026-10 D2），此处 re-export。
export { JOB_STATUS_LABEL, JOB_STATUS_TONE, SKIP_REASON_LABEL, HOLD_REASON_LABEL } from '@/types/welink'
