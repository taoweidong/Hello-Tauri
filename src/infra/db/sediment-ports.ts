import type { NormalizedAnnouncement, WelinkMessage } from '@/types/welink'

/**
 * 知识沉淀域端口契约（knowledge-sedimentation：migration v6 四表 + welink 表只读原料扫描）。
 *
 * 与 welink/group/codehub 同款约定：上层只见 Promise 化类型 API；SQL 文本与事务边界
 * 封在实现里；桌面 = SQLite、浏览器 = 内存实现，两套实现共享同一组契约测试。
 *
 * 两条硬约束（改动时勿破坏）：
 *  1. **分页强制**（P7）：所有列表查询的签名都带 `limit`，实现内部必须拼 `LIMIT`。
 *  2. **评审闸**（K-E）：`approveDraft`/`rejectDraft` 只允许 `pending → 终态` 的单向流转，
 *     已评审条目不得被再次改写（乐观并发由 `WHERE status='pending'` 保证）。
 */

/** 落库后的群公告（`welink_announcements`；写入形状即 welink 端口的 NormalizedAnnouncement） */
export interface WelinkAnnouncement {
  pk: number
  annUid: string
  convPk: number
  convId: string
  title: string
  content: string
  publishedAt: string
  createdAt: string
}

/** 待评审条目状态：pending = 待人工裁决；approved/rejected = 终态（不可逆） */
export type KnowledgeDraftStatus = 'pending' | 'approved' | 'rejected'

/** 原料类型：群消息 / 群公告 / 已答复问答对 */
export type KnowledgeDraftSource = 'message' | 'announcement' | 'qa'

/** 提取条目的写入草稿（`contentHash` 由编排层计算：正文规范化指纹） */
export interface KnowledgeDraftInput {
  title: string
  content: string
  topic: string
  sourceType: KnowledgeDraftSource
  /** 来源引用（消息 uid / 公告 uid / job pk），评审时回溯原料用 */
  sourceRefs: string[]
  contentHash: string
}

/** 待评审知识条目（`knowledge_drafts`）。approved/rejected 仅留评审痕迹，不入知识库清单 */
export interface KnowledgeDraft {
  pk: number
  title: string
  content: string
  topic: string
  sourceType: KnowledgeDraftSource
  sourceRefs: string[]
  contentHash: string
  status: KnowledgeDraftStatus
  reviewNote: string
  createdAt: string
  reviewedAt: string | null
}

/** 沉淀提取的大模型调用留痕（`sediment_logs`，与回复任务的 R4 语料分表，K-D） */
export interface SedimentLogInput {
  prompt: string
  response: string
  status: 'ok' | 'error' | 'timeout'
  latencyMs: number
  error: string
}

export interface SedimentLog {
  pk: number
  prompt: string
  response: string
  status: 'ok' | 'error' | 'timeout'
  latencyMs: number
  error: string
  createdAt: string
}

/** 已答复任务的问答对视图（问答归档原料；question 为触发消息正文，answer 为最终草稿） */
export interface SentQaRecord {
  pk: number
  targetId: string
  skillId: string
  skillName: string
  skillSource: string
  question: string
  answer: string
  rating: 'up' | 'down' | null
  finishedAt: string
}

/** `sediment_state` 水位键（key 约定集中在此，防拼写漂移；K-B：运行态不进 config.json） */
export const SEDIMENT_KEYS = {
  /** 已提取消费的最大消息 pk */
  messagePk: 'message_pk',
  /** 已提取消费的最大公告 pk */
  announcementPk: 'announcement_pk',
  /** 已归档消费的最大问答 finished_at（ISO 字符串比较） */
  qaFinishedAt: 'qa_finished_at',
  /** 提取连续失败计数（成功归零；≥3 跳过本轮并告警） */
  failStreak: 'extract_fail_streak',
} as const

export interface SedimentRepository {
  // —— 公告（原料采集；ann_uid 幂等） ——
  /** 幂等批写公告，返回**本次真正新增**的条目（含主键；会话不存在或重复的条目跳过） */
  applyAnnouncements(items: NormalizedAnnouncement[]): Promise<WelinkAnnouncement[]>
  listAnnouncements(limit: number, offset: number): Promise<WelinkAnnouncement[]>
  /** 提取消费扫描：pk 严格大于 afterPk 的公告，升序返回（水位推进依据，P7） */
  listAnnouncementsSince(afterPk: number, limit: number): Promise<WelinkAnnouncement[]>

  // —— 待评审条目（评审闸，K-E） ——
  /**
   * 批量入库待评审条目：`content_hash` 已存在（任意状态）的条目**静默丢弃**，
   * 返回真正入库的条目 —— 「重复知识不重复入库」的落库侧保证。
   */
  insertDrafts(drafts: KnowledgeDraftInput[]): Promise<KnowledgeDraft[]>
  listDrafts(query: { status?: KnowledgeDraftStatus; limit: number; offset: number }): Promise<KnowledgeDraft[]>
  countDrafts(status?: KnowledgeDraftStatus): Promise<number>
  /** 批量预检：返回入参中已存在于库中的 content_hash（与 insertDrafts 同口径） */
  findKnownHashes(hashes: string[]): Promise<string[]>
  /** pending → approved：同条 UPDATE 落评审后的最终标题与正文（评审可编辑），返回是否生效 */
  approveDraft(pk: number, patch: { title: string; content: string }): Promise<boolean>
  /** pending → rejected：note 留评审痕迹，返回是否生效 */
  rejectDraft(pk: number, note: string): Promise<boolean>

  // —— 水位（sediment_state kv） ——
  getState(key: string): Promise<string | null>
  setState(key: string, value: string): Promise<void>

  // —— 沉淀调用留痕 ——
  insertSedimentLog(log: SedimentLogInput): Promise<SedimentLog>
  listSedimentLogs(limit: number): Promise<SedimentLog[]>
  /** 清理提取留痕（对齐 clearAgentLogs 的「提供清理入口」哲学；返回删除条数） */
  clearSedimentLogs(): Promise<number>

  // —— 原料扫描（对 welink 表**只读**；P7：恒带 limit） ——
  /** 白名单群会话的入方向消息增量（pk 严格大于 afterPk，升序返回；白名单为空返回空） */
  listInMessagesSince(afterPk: number, convIds: string[], limit: number): Promise<WelinkMessage[]>
  /** 已答复任务的问答对增量（finished_at 严格大于 after；rating=up 优先、时间升序） */
  listSentQaSince(afterFinishedAt: string, limit: number): Promise<SentQaRecord[]>
}
