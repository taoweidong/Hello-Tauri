/**
 * WeLink 四表仓储（SQLite 实现，业务 SQL 全在这里 —— 设计 §3.1 / §4）。
 *
 * 本文件只做三件事：拼 SQL、绑参数、把行映射成类型化对象。所有业务判断
 * （触发规则、限流、熔断）都在编排层，数据层保持「哑」以便单测直接断言 SQL。
 *
 * 三条不变量（改代码前必读）：
 *  1. **分页强制**（P7）：每个列表方法都带 limit，SQL 必含 `LIMIT`。
 *  2. **要点3**：`commitDraft` 里 draft 与 `status='ready'` 必须在同一条 UPDATE。
 *  3. **防双发**：`markSent` 用 `WHERE id=?1 AND status='sending'` 做乐观并发，
 *     配合 `hasOutgoingReceipt` 的回执核对，保证同一 job 不会被发两次。
 */
import { bridge } from '@/api'
import type { DbParam, DbRow } from '@/types'
import type {
  HoldReason,
  JobRating,
  JobStatus,
  SkillSource,
  TriggerType,
  WelinkAgentLog,
  WelinkConversation,
  WelinkConvType,
  WelinkJob,
  WelinkMessage,
} from '@/types/welink'
import { nowStamp } from '@/utils/time'
import type {
  ApplyResult,
  ApplyRules,
  InboxQuery,
  InboxThread,
  JobDraft,
  JobQuery,
  JobStats,
  MessageQuery,
  SkillAttribution,
  WelinkRepository,
} from '../ports'
import { escapeLike } from '../like'
import { UNFINISHED_HARD_LIMIT, WATCHING_HARD_LIMIT } from '../ports'

// ---------------------------------------------------------------- 行映射

/** SQLite 布尔列（INTEGER 0/1）→ TS boolean */
const flag = (value: DbParam | undefined): boolean => Number(value ?? 0) === 1
/** TS boolean → SQLite INTEGER */
const bit = (value: boolean): number => (value ? 1 : 0)
const str = (value: DbParam | undefined): string => (value === null || value === undefined ? '' : String(value))
const num = (value: DbParam | undefined): number => Number(value ?? 0)
/** 可空文本列：空串与 null 都归一为 null（`mute_until`/`finished_at` 的语义） */
const nullable = (value: DbParam | undefined): string | null => {
  const text = str(value)
  return text ? text : null
}

function conversationFromRow(row: DbRow): WelinkConversation {
  return {
    pk: num(row.id),
    convType: (str(row.conv_type) === 'private' ? 'private' : 'group') as WelinkConvType,
    convId: str(row.conv_id),
    title: str(row.title),
    remark: str(row.remark),
    watching: flag(row.watching),
    autoReply: flag(row.auto_reply),
    muteUntil: nullable(row.mute_until),
    lastMsgAt: str(row.last_msg_at),
    unreadCount: num(row.unread_count),
    mentionCount: num(row.mention_count),
    lastActive: str(row.last_active),
    lastCursor: str(row.last_cursor),
    updatedAt: str(row.updated_at),
  }
}

function messageFromRow(row: DbRow): WelinkMessage {
  return {
    pk: num(row.id),
    convPk: num(row.conv_pk),
    msgUid: str(row.msg_uid),
    convType: (str(row.conv_type) === 'private' ? 'private' : 'group') as WelinkConvType,
    convId: str(row.conv_id),
    direction: str(row.direction) === 'out' ? 'out' : 'in',
    senderId: str(row.sender_id),
    senderName: str(row.sender_name),
    content: str(row.content),
    msgType: str(row.msg_type) || 'text',
    atMe: flag(row.at_me),
    readFlag: flag(row.read_flag),
    sentAt: str(row.sent_at),
  }
}

function jobFromRow(row: DbRow): WelinkJob {
  return {
    pk: num(row.id),
    triggerMsgPk: num(row.trigger_msg_pk),
    triggerType: (['group_at_me', 'private', 'manual'].includes(str(row.trigger_type))
      ? str(row.trigger_type)
      : 'manual') as TriggerType,
    targetType: (str(row.target_type) === 'private' ? 'private' : 'group') as WelinkConvType,
    targetId: str(row.target_id),
    sendModeUsed: str(row.send_mode_used) === 'manual' ? 'manual' : 'auto',
    contextSnapshot: str(row.context_snapshot),
    draft: str(row.draft),
    status: str(row.status) as JobStatus,
    attempts: num(row.attempts),
    lastError: str(row.last_error),
    skipReason: str(row.skip_reason),
    holdReason: str(row.hold_reason),
    skillId: str(row.skill_id),
    skillName: str(row.skill_name),
    skillSource: str(row.skill_source) as SkillSource | '',
    rating: (str(row.rating) === 'up' || str(row.rating) === 'down' ? str(row.rating) : null) as JobRating | null,
    createdAt: str(row.created_at),
    updatedAt: str(row.updated_at),
    finishedAt: nullable(row.finished_at),
    triggerSummary: str(row.trigger_summary),
    targetTitle: str(row.target_title),
  }
}

function agentLogFromRow(row: DbRow): WelinkAgentLog {
  return {
    pk: num(row.id),
    jobPk: num(row.job_pk),
    seq: num(row.seq),
    prompt: str(row.prompt),
    response: str(row.response),
    status: str(row.status) as WelinkAgentLog['status'],
    latencyMs: num(row.latency_ms),
    error: str(row.error),
    createdAt: str(row.created_at),
  }
}

// ---------------------------------------------------------------- SQL 片段

/** 会话行转展示字段的 SELECT 列表（多处复用，避免列名漂移） */
const CONV_COLUMNS = `id, conv_type, conv_id, title, remark, watching, auto_reply, mute_until,
       last_msg_at, unread_count, mention_count, last_active, last_cursor, updated_at`

/**
 * 消息行 + 会话类型/ID。消息表只存 conv_pk，但提示词与 UI 都需要 convId，
 * 因此读路径恒联表（写路径仍只写 conv_pk，保持规范化）。
 */
const MESSAGE_SELECT = `SELECT m.id, m.conv_pk, m.msg_uid, m.direction, m.sender_id, m.sender_name,
       m.content, m.msg_type, m.at_me, m.read_flag, m.sent_at,
       c.conv_type AS conv_type, c.conv_id AS conv_id
  FROM welink_messages m JOIN welink_conversations c ON c.id = m.conv_pk`

/** job 行 + 触发消息摘要 + 目标会话标题（列表展示的一站式读路径） */
const JOB_SELECT = `SELECT j.id, j.trigger_msg_pk, j.trigger_type, j.target_type, j.target_id,
       j.send_mode_used, j.context_snapshot, j.draft, j.status, j.attempts, j.last_error,
       j.skip_reason, j.hold_reason, j.skill_id, j.skill_name, j.skill_source,
       j.rating, j.created_at, j.updated_at, j.finished_at,
       COALESCE(substr(m.content, 1, 120), '') AS trigger_summary,
       COALESCE(c.title, '') AS target_title
  FROM welink_reply_jobs j
  LEFT JOIN welink_messages m ON m.id = j.trigger_msg_pk
  LEFT JOIN welink_conversations c ON c.conv_id = j.target_id`

/** 构造 IN 列表占位符：`?1, ?2, ?3`（参数化，杜绝拼接注入） */
function placeholders(count: number, offset = 0): string {
  return Array.from({ length: count }, (_, index) => `?${index + 1 + offset}`).join(', ')
}

/** 按条件拼 WHERE 子句并同步收集参数（保持「SQL 与参数一一对应」） */
class WhereBuilder {
  private readonly clauses: string[] = []
  readonly params: DbParam[] = []

  add(clause: string, ...values: DbParam[]): this {
    this.clauses.push(clause)
    this.params.push(...values)
    return this
  }

  addIn(column: string, values: (string | number)[]): this {
    if (!values.length) return this
    const start = this.params.length + 1
    this.clauses.push(`${column} IN (${Array.from({ length: values.length }, (_, i) => `?${start + i}`).join(', ')})`)
    this.params.push(...values)
    return this
  }

  get where(): string {
    return this.clauses.length ? `WHERE ${this.clauses.join(' AND ')}` : ''
  }
}

/** 组合 SELECT + WHERE + LIMIT/OFFSET，返回 SQL 与参数 */
function paged(select: string, where: WhereBuilder, orderBy: string, limit: number, offset = 0) {
  const sql = `${select} ${where.where} ${orderBy} LIMIT ?${where.params.length + 1} OFFSET ?${where.params.length + 2}`
  return { sql, params: [...where.params, limit, offset] }
}

function countOf(select: string, where: WhereBuilder) {
  const sql = `${select} ${where.where}`
  return { sql, params: where.params }
}

/**
 * 收件箱 WHERE 构造（`listInbox` 与 `countInbox` **共用**，保证「列表与计数的筛选口径」不会漂移）。
 *
 * 一次处理两个易错点：
 *
 * 1. **日期条件必须同时作用于「是否存在 in 消息」与「最后一条 in 消息内容」**。
 *    原实现用 `JOIN welink_messages m` 表达前者，但 `last_content` 相关子查询**没带**
 *    日期条件 —— 于是「按最近 30 天筛选，预览却显示半年前的那句话」。内存实现一直带
 *    日期过滤，两套实现由此漂移（契约测试现已覆盖该点）。这里改用 `EXISTS(...)`
 *    表达「范围内有 in 消息」，并把同一份日期片段复用到子查询，使两侧语义一致；
 *    同时**去掉 `GROUP BY`** —— 不再对消息表做聚合（P-4 的退化根源）。
 *
 * 2. **同一占位符可复用**：SQLite 允许一条语句里 `?N` 出现多次，因此日期参数只收集
 *    一次、占位符写两遍即可。这是能同时保持「参数不重复」与「两处条件一致」的关键。
 *
 * 返回的 `dateFilter` 是供 `listInbox` 复用到 `last_content` 子查询的原始片段
 * （形如 ` AND x.sent_at >= ?1 AND x.sent_at <= ?2`，无日期时为空串）。
 */
function buildInboxWhere(query: Omit<InboxQuery, 'limit' | 'offset'>): {
  where: string
  params: DbParam[]
  dateFilter: string
} {
  const params: DbParam[] = []
  /** 收集参数并返回其 1-based 序号（与 SQLite 的 `?N` 口径一致） */
  const hold = (value: DbParam): number => {
    params.push(value)
    return params.length
  }

  const dateClauses: string[] = []
  if (query.from) dateClauses.push(`x.sent_at >= ?${hold(query.from)}`)
  if (query.to) dateClauses.push(`x.sent_at <= ?${hold(query.to)}`)
  const dateFilter = dateClauses.length ? ` AND ${dateClauses.join(' AND ')}` : ''

  const clauses = [
    "c.conv_type = 'private'",
    // 该会话在（筛选）范围内必须存在 in 消息 —— 原实现由 JOIN 隐式保证，不能丢
    `EXISTS (SELECT 1 FROM welink_messages x WHERE x.conv_pk = c.id AND x.direction = 'in'${dateFilter})`,
  ]

  const keyword = query.keyword?.trim()
  if (keyword) {
    // 同一占位符复用两次：标题与工号用同一个 LIKE 值（通配符转义，字面语义）
    const index = hold(`%${escapeLike(keyword)}%`)
    clauses.push(`(c.title LIKE ?${index} ESCAPE '\\' OR c.conv_id LIKE ?${index} ESCAPE '\\')`)
  }
  if (query.onlyUnreplied) {
    clauses.push(`EXISTS (
      SELECT 1 FROM welink_reply_jobs j
       WHERE j.target_id = c.conv_id AND j.status IN ('pending','discussing','ready','sending','failed'))`)
  }

  return { where: `WHERE ${clauses.join(' AND ')}`, params, dateFilter }
}

// ---------------------------------------------------------------- 仓储实现

export const sqlWelinkRepository: WelinkRepository = {
  // ---------------- 会话 ----------------

  async listConversations(limit, offset) {
    const rows = await bridge.dbSelect(
      `SELECT ${CONV_COLUMNS} FROM welink_conversations
        ORDER BY conv_type, last_msg_at DESC, id DESC LIMIT ?1 OFFSET ?2`,
      [limit, offset],
    )
    return rows.map(conversationFromRow)
  },

  async countConversations() {
    const rows = await bridge.dbSelect('SELECT COUNT(*) AS count FROM welink_conversations')
    return num(rows[0]?.count)
  },

  async listWatching() {
    // P7 受控例外（见 ports.ts 说明）：调度输入集不分页，但仍带硬上限防呆
    const rows = await bridge.dbSelect(
      `SELECT ${CONV_COLUMNS} FROM welink_conversations WHERE watching = 1 ORDER BY id LIMIT ?1`,
      [WATCHING_HARD_LIMIT],
    )
    return rows.map(conversationFromRow)
  },

  async getConversation(convId) {
    const rows = await bridge.dbSelect(`SELECT ${CONV_COLUMNS} FROM welink_conversations WHERE conv_id = ?1`, [convId])
    return rows[0] ? conversationFromRow(rows[0]) : null
  },

  async upsertConversation(draft) {
    const now = nowStamp()
    await bridge.dbExecute(
      `INSERT INTO welink_conversations(conv_type, conv_id, title, remark, watching, auto_reply, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
       ON CONFLICT(conv_id) DO UPDATE SET
         title = CASE WHEN excluded.title <> '' THEN excluded.title ELSE welink_conversations.title END,
         updated_at = excluded.updated_at`,
      [
        draft.convType,
        draft.convId,
        draft.title ?? '',
        draft.remark ?? '',
        bit(draft.watching ?? false),
        bit(draft.autoReply ?? false),
        now,
      ],
    )
    const saved = await sqlWelinkRepository.getConversation(draft.convId)
    if (!saved) throw new Error(`会话写入后仍读取不到：${draft.convId}`)
    return saved
  },

  async updateConversation(convId, patch) {
    const sets: string[] = ['updated_at = ?2']
    const params: DbParam[] = [convId, nowStamp()]
    const push = (column: string, value: DbParam) => {
      params.push(value)
      sets.push(`${column} = ?${params.length}`)
    }
    if (patch.title !== undefined) push('title', patch.title)
    if (patch.remark !== undefined) push('remark', patch.remark)
    if (patch.watching !== undefined) push('watching', bit(patch.watching))
    if (patch.autoReply !== undefined) push('auto_reply', bit(patch.autoReply))
    if (patch.muteUntil !== undefined) push('mute_until', patch.muteUntil)
    await bridge.dbExecute(`UPDATE welink_conversations SET ${sets.join(', ')} WHERE conv_id = ?1`, params)
  },

  async setAutoReply(convIds, enabled) {
    if (!convIds.length) return 0
    const result = await bridge.dbExecute(
      `UPDATE welink_conversations SET auto_reply = ?1, updated_at = ?2
        WHERE conv_id IN (${placeholders(convIds.length, 2)})`,
      [bit(enabled), nowStamp(), ...convIds],
    )
    return result.changes
  },

  async removeConversation(convId) {
    // messages 声明了 ON DELETE CASCADE，但 jobs 只引用 messages.id 而未级联到会话，
    // 因此显式按 target_id 清理，避免留下悬挂任务（否则回复历史会出现「目标已删除」的空行）。
    const conv = await bridge.dbSelect('SELECT id FROM welink_conversations WHERE conv_id = ?1', [convId])
    const convPk = num(conv[0]?.id)
    if (convPk) {
      await bridge.dbTransaction([
        {
          sql: 'DELETE FROM welink_agent_logs WHERE job_pk IN (SELECT id FROM welink_reply_jobs WHERE target_id = ?1)',
          params: [convId],
        },
        { sql: 'DELETE FROM welink_reply_jobs WHERE target_id = ?1', params: [convId] },
        { sql: 'DELETE FROM welink_messages WHERE conv_pk = ?1', params: [convPk] },
        { sql: 'DELETE FROM welink_conversations WHERE id = ?1', params: [convPk] },
      ])
    }
  },

  // ---------------- 消息 ----------------

  async applyPollResult(convId, messages, cursor, rules: ApplyRules) {
    const convRows = await bridge.dbSelect('SELECT id FROM welink_conversations WHERE conv_id = ?1', [convId])
    const convPk = num(convRows[0]?.id)
    if (!convPk) throw new Error(`会话未在监控清单中：${convId}`)

    const now = nowStamp()
    // 已入库的 msg_uid（幂等去重）：只查本批涉及的 UID，避免全表扫描
    const uids = messages.map((item) => item.msgUid)
    const existing = uids.length
      ? await bridge.dbSelect(
          `SELECT msg_uid FROM welink_messages WHERE msg_uid IN (${placeholders(uids.length)})`,
          uids,
        )
      : []
    const known = new Set(existing.map((row) => str(row.msg_uid)))
    const fresh = messages.filter((item) => !known.has(item.msgUid))

    const inserted: WelinkMessage[] = []
    const insertStatements: { sql: string; params?: DbParam[] }[] = []
    const createJobStatements: { sql: string; params?: DbParam[] }[] = []
    const createdJobUids: TriggerType[] = []

    for (const message of fresh) {
      insertStatements.push({
        sql: `INSERT OR IGNORE INTO welink_messages
              (msg_uid, conv_pk, direction, sender_id, sender_name, content, msg_type, at_me, read_flag, sent_at, created_at)
              VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`,
        params: [
          message.msgUid,
          convPk,
          message.direction,
          message.senderId,
          message.senderName,
          message.content,
          message.msgType,
          bit(message.atMe),
          // 自己发出的消息直接算已读；收到的 unread 由汇总列统计，行级 read_flag 供「已读批量置位」
          0,
          message.sentAt,
          now,
        ],
      })
      const trigger = rules.triggers[message.msgUid]
      if (!trigger) continue
      createdJobUids.push(trigger)
      createJobStatements.push({
        // 触发消息主键用 msg_uid 子查询取：同一事务内 INSERT 后可见，无需回读 lastInsertId
        sql: `INSERT INTO welink_reply_jobs
                (trigger_msg_pk, trigger_type, target_type, target_id, send_mode_used,
                 context_snapshot, draft, status, attempts, last_error, skip_reason, hold_reason,
                 created_at, updated_at)
              VALUES (
                (SELECT id FROM welink_messages WHERE msg_uid = ?1),
                ?2, ?3, ?4, ?5, '', '', 'pending', 0, '', '', '', ?6, ?6)`,
        params: [message.msgUid, trigger, message.convType, message.convId, rules.sendMode, now],
      })
    }

    // 汇总列增量维护（O3）：一次 UPDATE 完成，列表查询因此零聚合
    const incoming = fresh.filter((item) => item.direction === 'in')
    const unreadDelta = incoming.length
    const mentionDelta = incoming.filter((item) => item.atMe && item.msgType === 'text').length
    const lastMsgAt = fresh.reduce((latest, item) => (item.sentAt > latest ? item.sentAt : latest), '')

    const statements = [...insertStatements, ...createJobStatements]
    statements.push({
      sql: `UPDATE welink_conversations SET
              last_cursor = ?2,
              updated_at = ?3,
              unread_count = unread_count + ?4,
              mention_count = mention_count + ?5,
              last_msg_at = CASE WHEN ?6 <> '' THEN ?6 ELSE last_msg_at END,
              last_active = CASE WHEN ?6 <> '' THEN ?3 ELSE last_active END
            WHERE id = ?1`,
      params: [convPk, cursor, now, unreadDelta, mentionDelta, lastMsgAt],
    })

    if (statements.length) await bridge.dbTransaction(statements)

    // 回读刚插入的行（拿主键 + 让 store 拿到完整消息对象做增量补丁，P5）
    if (fresh.length) {
      const rows = await bridge.dbSelect(
        `${MESSAGE_SELECT} WHERE m.msg_uid IN (${placeholders(fresh.length)}) ORDER BY m.sent_at, m.id`,
        fresh.map((item) => item.msgUid),
      )
      inserted.push(...rows.map(messageFromRow))
    }

    const createdJobs = createdJobUids.length
      ? await bridge.dbSelect(`${JOB_SELECT} WHERE j.target_id = ?1 AND j.created_at = ?2 ORDER BY j.id`, [convId, now])
      : []

    return { inserted, createdJobs: createdJobs.map(jobFromRow), cursor } satisfies ApplyResult
  },

  async getMessage(pk) {
    const rows = await bridge.dbSelect(`${MESSAGE_SELECT} WHERE m.id = ?1`, [pk])
    return rows[0] ? messageFromRow(rows[0]) : null
  },

  async listMessages(query: MessageQuery) {
    const where = new WhereBuilder().add('m.conv_pk = ?1', query.convPk)
    if (query.before) where.add(`m.sent_at < ?${where.params.length + 1}`, query.before)
    if (query.keyword?.trim()) {
      const like = `%${escapeLike(query.keyword.trim())}%`
      where.add(
        `(m.content LIKE ?${where.params.length + 1} ESCAPE '\\' OR m.sender_name LIKE ?${where.params.length + 2} ESCAPE '\\')`,
        like,
        like,
      )
    }
    // 倒序取最近 N 条，再翻正序展示（向上翻页语义）
    const { sql, params } = paged(MESSAGE_SELECT, where, 'ORDER BY m.sent_at DESC, m.id DESC', query.limit)
    const rows = await bridge.dbSelect(sql, params)
    return rows.map(messageFromRow).reverse()
  },

  async searchMessages(keyword, from, to, limit, offset) {
    const where = new WhereBuilder()
    const like = `%${escapeLike(keyword.trim())}%`
    if (keyword.trim()) where.add(`(m.content LIKE ?1 ESCAPE '\\' OR m.sender_name LIKE ?2 ESCAPE '\\')`, like, like)
    if (from) where.add(`m.sent_at >= ?${where.params.length + 1}`, from)
    if (to) where.add(`m.sent_at <= ?${where.params.length + 1}`, to)
    const { sql, params } = paged(MESSAGE_SELECT, where, 'ORDER BY m.sent_at DESC, m.id DESC', limit, offset)
    const rows = await bridge.dbSelect(sql, params)
    return rows.map(messageFromRow)
  },

  async markRead(convPk) {
    // 单事务：行级 read_flag 置位 + 汇总列清零（O6 的唯一真值口径）
    const now = nowStamp()
    await bridge.dbTransaction([
      { sql: 'UPDATE welink_messages SET read_flag = 1 WHERE conv_pk = ?1 AND read_flag = 0', params: [convPk] },
      {
        sql: `UPDATE welink_conversations SET unread_count = 0, mention_count = 0, updated_at = ?2 WHERE id = ?1`,
        params: [convPk, now],
      },
    ])
  },

  async recentContext(convPk, maxN) {
    // 取最近 maxN 条（含 out），倒序查后翻正序 —— 提示词里时间必须正序
    const rows = await bridge.dbSelect(
      `${MESSAGE_SELECT} WHERE m.conv_pk = ?1 ORDER BY m.sent_at DESC, m.id DESC LIMIT ?2`,
      [convPk, Math.max(1, maxN)],
    )
    return rows.map(messageFromRow).reverse()
  },

  async listInbox(query: InboxQuery) {
    // 收件箱 = 范围内有过私聊 in 消息的会话 + 未读数 + 范围内最后一条 in 内容（R2）。
    // 不再是 JOIN + GROUP BY：用 EXISTS 判存在性，避免按消息量做聚合（P-4）。
    const { where, params, dateFilter } = buildInboxWhere(query)
    const sql = `SELECT c.id AS conv_pk, c.conv_id, c.title, c.unread_count, c.last_msg_at,
              (SELECT x.content FROM welink_messages x
                WHERE x.conv_pk = c.id AND x.direction = 'in'${dateFilter}
                ORDER BY x.sent_at DESC, x.id DESC LIMIT 1) AS last_content
         FROM welink_conversations c
        ${where}
        ORDER BY c.last_msg_at DESC, c.id DESC
        LIMIT ?${params.length + 1} OFFSET ?${params.length + 2}`
    const rows = await bridge.dbSelect(sql, [...params, query.limit, query.offset])
    return rows.map((row): InboxThread => ({
      convPk: num(row.conv_pk),
      convId: str(row.conv_id),
      title: str(row.title) || str(row.conv_id),
      unreadCount: num(row.unread_count),
      lastMsgAt: str(row.last_msg_at),
      lastContent: str(row.last_content),
    }))
  },

  async countInbox(query) {
    // 与 listInbox 共用 buildInboxWhere：筛选口径不漂移；
    // 也不再需要 COUNT(DISTINCT c.id) —— 已无 JOIN 造成的行放大。
    const { where, params } = buildInboxWhere(query)
    const sql = `SELECT COUNT(*) AS count FROM welink_conversations c ${where}`
    const rows = await bridge.dbSelect(sql, params)
    return num(rows[0]?.count)
  },

  // ---------------- 回复任务 ----------------

  async createJob(draft: JobDraft) {
    const now = nowStamp()
    // 触发消息主键优先用 msgUid 回查：跨重启恢复时调用方只有 uid，
    // 且 msgUid 是唯一键，回查结果与落库行是一一对应关系。
    const triggerRows = await bridge.dbSelect('SELECT id FROM welink_messages WHERE msg_uid = ?1', [
      draft.triggerMsgUid,
    ])
    const triggerPk = num(triggerRows[0]?.id) || draft.triggerMsgPk
    const result = await bridge.dbExecute(
      `INSERT INTO welink_reply_jobs
         (trigger_msg_pk, trigger_type, target_type, target_id, send_mode_used,
          context_snapshot, draft, status, attempts, last_error, skip_reason, hold_reason, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, '', 'pending', 0, '', '', '', ?7, ?7)`,
      [triggerPk, draft.triggerType, draft.targetType, draft.targetId, draft.sendModeUsed, draft.contextSnapshot, now],
    )
    const job = await sqlWelinkRepository.getJob(result.lastInsertId)
    if (!job) throw new Error('回复任务写入后仍读取不到')
    return job
  },

  async getJob(pk) {
    const rows = await bridge.dbSelect(`${JOB_SELECT} WHERE j.id = ?1`, [pk])
    return rows[0] ? jobFromRow(rows[0]) : null
  },

  async listJobsByStatus(status, limit) {
    const where = new WhereBuilder()
    if (status.length) where.addIn('j.status', status)
    const { sql, params } = paged(JOB_SELECT, where, 'ORDER BY j.created_at, j.id', limit)
    const rows = await bridge.dbSelect(sql, params)
    return rows.map(jobFromRow)
  },

  async listUnfinishedJobs() {
    // P7 受控例外（见 ports.ts 说明）：启动恢复的工作集，带硬上限兜底
    const rows = await bridge.dbSelect(
      `${JOB_SELECT} WHERE j.status IN ('pending','discussing','ready','sending','failed')
        ORDER BY j.created_at, j.id LIMIT ?1`,
      [UNFINISHED_HARD_LIMIT],
    )
    return rows.map(jobFromRow)
  },

  async listJobs(query: JobQuery) {
    const where = buildJobWhere(query)
    const { sql, params } = paged(JOB_SELECT, where, 'ORDER BY j.created_at DESC, j.id DESC', query.limit, query.offset)
    const rows = await bridge.dbSelect(sql, params)
    return rows.map(jobFromRow)
  },

  async countJobs(query) {
    const where = buildJobWhere(query)
    const { sql, params } = countOf(
      `SELECT COUNT(*) AS count FROM welink_reply_jobs j
       LEFT JOIN welink_messages m ON m.id = j.trigger_msg_pk
       LEFT JOIN welink_conversations c ON c.conv_id = j.target_id`,
      where,
    )
    const rows = await bridge.dbSelect(sql, params)
    return num(rows[0]?.count)
  },

  async jobStats(dayStart, hourStart) {
    // 统计条（R3）用四条聚合一次取回，避免 N 次 IPC 往返
    const rows = await bridge.dbSelect(
      `SELECT
         SUM(CASE WHEN created_at >= ?1 THEN 1 ELSE 0 END) AS today_count,
         SUM(CASE WHEN status = 'sent' THEN 1 ELSE 0 END) AS sent_count,
         SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed_count,
         SUM(CASE WHEN status = 'skipped' THEN 1 ELSE 0 END) AS skipped_count,
         SUM(CASE WHEN status = 'sent' THEN
               (CAST(strftime('%s', finished_at) AS INTEGER) - CAST(strftime('%s', created_at) AS INTEGER))
             ELSE 0 END) AS latency_total,
         SUM(CASE WHEN created_at >= ?2 AND status IN ('sent','failed') THEN 1 ELSE 0 END) AS attempted_hour
       FROM welink_reply_jobs`,
      [dayStart, hourStart],
    )
    const row = rows[0] ?? {}
    const sent = num(row.sent_count)
    const failed = num(row.failed_count)
    const attempted = sent + failed
    return {
      todayCount: num(row.today_count),
      sentCount: sent,
      failedCount: failed,
      successRate: attempted ? sent / attempted : 1,
      avgLatencySec: sent ? Math.round(num(row.latency_total) / sent) : 0,
      skippedCount: num(row.skipped_count),
    } satisfies JobStats
  },

  async markStatus(pk, status, expect) {
    const params: DbParam[] = [status, nowStamp(), pk]
    let sql = 'UPDATE welink_reply_jobs SET status = ?1, updated_at = ?2 WHERE id = ?3'
    if (expect) {
      params.push(expect)
      sql += ` AND status = ?${params.length}`
    }
    const result = await bridge.dbExecute(sql, params)
    return result.changes > 0
  },

  async commitDraft(pk, draft, contextSnapshot, skill?: SkillAttribution) {
    // 要点3：draft 与 status='ready' 必须**同一条 UPDATE** —— 拆成两句就存在
    // 「草稿已写但状态未就绪」的中间态，而设计的前提是「库中无草稿不得外发」。
    // WHERE status='discussing' 是乐观并发：同一 job 被两个 worker 处理时只有先到者生效。
    // 技能三列并入同条 UPDATE（skill-routing D5）：分类结果与草稿原子落库，避免
    // 「草稿已就绪但留痕缺失」的中间态被回复历史读到。
    const now = nowStamp()
    const sets = ['draft = ?1', "status = 'ready'", 'updated_at = ?2', "hold_reason = ''"]
    const params: DbParam[] = [draft, now]
    if (contextSnapshot !== undefined) {
      params.push(contextSnapshot)
      sets.push(`context_snapshot = ?${params.length}`)
    }
    if (skill) {
      params.push(skill.id, skill.name, skill.source)
      sets.push(`skill_id = ?${params.length - 2}`)
      sets.push(`skill_name = ?${params.length - 1}`)
      sets.push(`skill_source = ?${params.length}`)
    }
    params.push(pk)
    const idParam = params.length
    const result = await bridge.dbExecute(
      `UPDATE welink_reply_jobs SET ${sets.join(', ')} WHERE id = ?${idParam} AND status = 'discussing'`,
      params,
    )
    return result.changes > 0
  },

  async recordAttemptFailure(pk, status, error) {
    await bridge.dbExecute(
      `UPDATE welink_reply_jobs SET attempts = attempts + 1, last_error = ?1,
         status = ?2, updated_at = ?3,
         finished_at = CASE WHEN ?2 IN ('failed','skipped') THEN ?3 ELSE finished_at END
       WHERE id = ?4`,
      [error.slice(0, 500), status, nowStamp(), pk],
    )
  },

  async requeueJob(pk) {
    const result = await bridge.dbExecute(
      `UPDATE welink_reply_jobs SET status = 'ready', skip_reason = '', hold_reason = '',
         last_error = '', updated_at = ?1, finished_at = NULL
       WHERE id = ?2 AND status IN ('failed','skipped','ready')`,
      [nowStamp(), pk],
    )
    return result.changes > 0
  },

  async skipJob(pk, reason) {
    const now = nowStamp()
    await bridge.dbExecute(
      `UPDATE welink_reply_jobs SET status = 'skipped', skip_reason = ?1, updated_at = ?2,
         finished_at = ?2 WHERE id = ?3 AND status IN ('ready','pending','discussing')`,
      [reason, now, pk],
    )
  },

  async holdJob(pk, reason: HoldReason | string) {
    await bridge.dbExecute(
      `UPDATE welink_reply_jobs SET status = 'ready', hold_reason = ?1, updated_at = ?2, finished_at = NULL
       WHERE id = ?3 AND status IN ('ready','pending','discussing','sending')`,
      [reason, nowStamp(), pk],
    )
  },

  async suspendJob(pk) {
    await bridge.dbExecute(
      `UPDATE welink_reply_jobs SET status = 'ready', hold_reason = '', updated_at = ?1, finished_at = NULL
       WHERE id = ?2 AND status IN ('ready','sending')`,
      [nowStamp(), pk],
    )
  },

  async updateDraft(pk, draft) {
    await bridge.dbExecute(`UPDATE welink_reply_jobs SET draft = ?1, updated_at = ?2, hold_reason = '' WHERE id = ?3`, [
      draft,
      nowStamp(),
      pk,
    ])
  },

  async rateJob(pk, rating) {
    await bridge.dbExecute('UPDATE welink_reply_jobs SET rating = ?1, updated_at = ?2 WHERE id = ?3', [
      rating,
      nowStamp(),
      pk,
    ])
  },

  async removeJob(pk) {
    // 单事务：先删留痕再删 job —— 反序会因 v1 表未声明 ON DELETE CASCADE 留下孤儿日志
    const changes = await bridge.dbTransaction([
      { sql: 'DELETE FROM welink_agent_logs WHERE job_pk = ?1', params: [pk] },
      { sql: 'DELETE FROM welink_reply_jobs WHERE id = ?1', params: [pk] },
    ])
    return (changes[1] ?? 0) > 0
  },

  async markSent(pk, receipt) {
    // 单事务：job → sent（带 status='sending' 乐观锁）+ 回写 out 消息（msg_uid 幂等）。
    // 两条语句任一失败整体回滚；`changes` 检查保证并发下只有一方记账。
    const changes = await bridge.dbTransaction([
      {
        sql: `UPDATE welink_reply_jobs SET status = 'sent', finished_at = ?1, updated_at = ?1, last_error = ''
               WHERE id = ?2 AND status = 'sending'`,
        params: [receipt.sentAt, pk],
      },
      {
        sql: `INSERT OR IGNORE INTO welink_messages
                (msg_uid, conv_pk, direction, sender_id, sender_name, content, msg_type, at_me, read_flag, sent_at, created_at)
              VALUES (?1, ?2, 'out', '', '', ?3, 'text', 0, 1, ?4, ?5)`,
        params: [receipt.msgUid, receipt.convPk, receipt.content, receipt.sentAt, nowStamp()],
      },
      {
        sql: `UPDATE welink_conversations SET last_msg_at = ?2, updated_at = ?2 WHERE id = ?1`,
        params: [receipt.convPk, receipt.sentAt],
      },
    ])
    return (changes[0] ?? 0) > 0
  },

  async hasOutgoingReceipt(pk) {
    // 回执核对（§6.2/§6.3）：若该 job 触发的会话里已存在同内容的 out 消息，
    // 说明上次「发出去了但没记上」，此时必须补记 sent 而不是重发。
    const rows = await bridge.dbSelect(
      `SELECT COUNT(*) AS count FROM welink_messages m
        WHERE m.direction = 'out' AND m.conv_pk IN (
          SELECT c.id FROM welink_reply_jobs j JOIN welink_conversations c ON c.conv_id = j.target_id WHERE j.id = ?1)
          AND m.content = (SELECT draft FROM welink_reply_jobs WHERE id = ?1)`,
      [pk],
    )
    return num(rows[0]?.count) > 0
  },

  async countHolding() {
    const rows = await bridge.dbSelect(
      `SELECT COUNT(*) AS count FROM welink_reply_jobs WHERE status = 'ready' AND hold_reason <> ''`,
    )
    return num(rows[0]?.count)
  },

  async countSentSince(targetId, since) {
    const rows = await bridge.dbSelect(
      `SELECT COUNT(*) AS count FROM welink_reply_jobs
        WHERE target_id = ?1 AND status = 'sent' AND finished_at >= ?2`,
      [targetId, since],
    )
    return num(rows[0]?.count)
  },

  async lastSentAt(targetId) {
    // 取 MAX(finished_at)：S1 只关心「最近一次」，不需要全部历史行
    const rows = await bridge.dbSelect(
      `SELECT MAX(finished_at) AS last_at FROM welink_reply_jobs
        WHERE target_id = ?1 AND status = 'sent' AND finished_at IS NOT NULL`,
      [targetId],
    )
    return nullable(rows[0]?.last_at)
  },

  async countGlobalSentSince(since) {
    const rows = await bridge.dbSelect(
      `SELECT COUNT(*) AS count FROM welink_reply_jobs WHERE status = 'sent' AND finished_at >= ?1`,
      [since],
    )
    return num(rows[0]?.count)
  },

  // ---------------- Agent 留痕（R4） ----------------

  async insertAgentLog(log) {
    const rows = await bridge.dbSelect(
      'SELECT COALESCE(MAX(seq), 0) AS last_seq FROM welink_agent_logs WHERE job_pk = ?1',
      [log.jobPk],
    )
    const seq = num(rows[0]?.last_seq) + 1
    const now = nowStamp()
    const result = await bridge.dbExecute(
      `INSERT INTO welink_agent_logs(job_pk, seq, prompt, response, status, latency_ms, error, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
      [log.jobPk, seq, log.prompt, log.response, log.status, log.latencyMs, log.error, now],
    )
    const stored = await bridge.dbSelect('SELECT * FROM welink_agent_logs WHERE id = ?1', [result.lastInsertId])
    return agentLogFromRow(stored[0] ?? {})
  },

  async listAgentLogs(jobPk) {
    const rows = await bridge.dbSelect('SELECT * FROM welink_agent_logs WHERE job_pk = ?1 ORDER BY seq', [jobPk])
    return rows.map(agentLogFromRow)
  },

  async listJobsWithLogs(limit, offset, onlyDownRated) {
    const where = new WhereBuilder().add('EXISTS (SELECT 1 FROM welink_agent_logs l WHERE l.job_pk = j.id)')
    if (onlyDownRated) where.add("j.rating = 'down'")
    const { sql, params } = paged(JOB_SELECT, where, 'ORDER BY j.created_at DESC, j.id DESC', limit, offset)
    const rows = await bridge.dbSelect(sql, params)
    return rows.map(jobFromRow)
  },

  async countJobsWithLogs(onlyDownRated) {
    // 与 listJobsWithLogs 共用同一 EXISTS 条件 —— 两处口径必须逐字一致
    const where = new WhereBuilder().add('EXISTS (SELECT 1 FROM welink_agent_logs l WHERE l.job_pk = j.id)')
    if (onlyDownRated) where.add("j.rating = 'down'")
    const { sql, params } = countOf('SELECT COUNT(*) AS count FROM welink_reply_jobs j', where)
    const rows = await bridge.dbSelect(sql, params)
    return num(rows[0]?.count)
  },

  async clearAgentLogs(jobPk) {
    const result = await bridge.dbExecute('DELETE FROM welink_agent_logs WHERE job_pk = ?1', [jobPk])
    return result.changes
  },

  // ---------------- 维护 ----------------

  async purgeMessagesBefore(cutoff, batch) {
    // P1：大事务分批。SQLite 的 DELETE 支持 LIMIT（编译时默认开启），
    // 但为兼容性用「子查询 + IN」实现等价语义。
    //
    // `NOT EXISTS` 是**必需的**，不是优化 —— `welink_reply_jobs.trigger_msg_pk` 声明为
    // `REFERENCES welink_messages(id)` 且**没有 ON DELETE 子句**（默认 NO ACTION），而宿主
    // 开着 `PRAGMA foreign_keys = ON`。只要存在任意一条 job 引用待删消息，整条 DELETE 就抛
    // `FOREIGN KEY constraint failed`、一行都删不掉，且异常被 retention 的 `.catch` 降级为
    // 一条 warn —— 保留期清理静默永久失效，消息表无界增长。
    //
    // 语义选择：跳过被引用的消息，**不级联删 job**（端口契约明写「只删留痕、不动 job」，
    // 且 job 是回复历史的主体，删了会让「某天回复了多少条」这类统计凭空缩水）。
    // 代价是「仍被 job 引用」的过期消息会留存 —— 但数量级等于历史 job 数（有界），
    // 而「无引用的消息」才是真正的膨胀来源。实测 9 行样本：删掉 5 条未引用、
    // 保留 3 条被引用 + 1 条未过期，job 与语料完整无损。
    //
    // 该子查询依赖 `idx_wrj_trigger_msg`（migration v7）：无索引时 EXPLAIN 为
    // `CORRELATED SCALAR SUBQUERY → SCAN j`，5 万行库上单批耗时 21.8s，会长时间独占
    // SQLite 全局连接锁、拖住所有 DB 命令；补索引后 8.3ms。
    const result = await bridge.dbExecute(
      `DELETE FROM welink_messages WHERE id IN (
         SELECT m.id FROM welink_messages m
          WHERE m.sent_at < ?1
            AND NOT EXISTS (SELECT 1 FROM welink_reply_jobs j WHERE j.trigger_msg_pk = m.id)
          ORDER BY m.id LIMIT ?2)`,
      [cutoff, batch],
    )
    return result.changes
  },

  async purgeAgentLogsBefore(cutoff, batch) {
    // 与消息清理同构（子查询 + LIMIT）。job 不受本方法影响（只删留痕），因此不存在
    // 悬垂引用；`purgeMessagesBefore` 跳过的那些被引用消息，其 job 仍在，
    // 对应的语料由本方法按 `created_at` 正常清理。
    const result = await bridge.dbExecute(
      `DELETE FROM welink_agent_logs WHERE id IN (
         SELECT id FROM welink_agent_logs WHERE created_at < ?1 ORDER BY id LIMIT ?2)`,
      [cutoff, batch],
    )
    return result.changes
  },

  async countMessages(convPk) {
    const rows = await bridge.dbSelect('SELECT COUNT(*) AS count FROM welink_messages WHERE conv_pk = ?1', [convPk])
    return num(rows[0]?.count)
  },

  async countUnrepliedThreads() {
    const rows = await bridge.dbSelect(
      `SELECT COUNT(DISTINCT c.id) AS count FROM welink_conversations c
        WHERE c.conv_type = 'private' AND EXISTS (
          SELECT 1 FROM welink_reply_jobs j
           WHERE j.target_id = c.conv_id AND j.status IN ('pending','discussing','ready','sending','failed'))`,
    )
    return num(rows[0]?.count)
  },
}

/** 回复历史筛选条件（列表与计数共用，保证两者口径一致） */
function buildJobWhere(query: Omit<JobQuery, 'limit' | 'offset'>): WhereBuilder {
  const where = new WhereBuilder()
  if (query.status?.length) where.addIn('j.status', query.status)
  if (query.triggerType?.length) where.addIn('j.trigger_type', query.triggerType)
  if (query.targetId) where.add(`j.target_id = ?${where.params.length + 1}`, query.targetId)
  if (query.onlySkipped) where.add("j.skip_reason <> ''")
  if (query.onlyHolding) where.add("j.hold_reason <> '' AND j.status = 'ready'")
  if (query.onlyDownRated) where.add("j.rating = 'down'")
  if (query.from) where.add(`j.created_at >= ?${where.params.length + 1}`, query.from)
  if (query.to) where.add(`j.created_at <= ?${where.params.length + 1}`, query.to)
  return where
}
