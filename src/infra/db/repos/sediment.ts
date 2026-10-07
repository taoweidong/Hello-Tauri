/**
 * 知识沉淀域仓储（SQLite 实现，migration v6 四表 + welink 表只读扫描）。
 *
 * 与 welink 仓储同款三条不变量：
 *  1. **分页强制**（P7）：每个列表 SQL 必含 LIMIT。
 *  2. **评审闸单向流**（K-E）：approve/reject 只对 `status='pending'` 生效，已评审不可改写。
 *  3. **幂等键**：公告 `ann_uid` UNIQUE（INSERT OR IGNORE），条目 `content_hash` 入库前预检。
 *
 * 原料扫描对 `welink_messages` / `welink_reply_jobs` **只读**：沉淀是旁路消费，
 * 不写回复域的任何表（两域失败隔离，K-A）。
 */
import { bridge } from '@/api'
import type { DbParam, DbRow } from '@/types'
import type { WelinkMessage } from '@/types/welink'
import { nowStamp } from '@/utils/time'
import type {
  KnowledgeDraft,
  KnowledgeDraftSource,
  KnowledgeDraftStatus,
  SedimentLog,
  SedimentRepository,
  WelinkAnnouncement,
} from '../sediment-ports'

// ---------------------------------------------------------------- 行映射

const str = (value: DbParam | undefined): string => (value === null || value === undefined ? '' : String(value))
const num = (value: DbParam | undefined): number => Number(value ?? 0)
const nullable = (value: DbParam | undefined): string | null => {
  const text = str(value)
  return text ? text : null
}
const jsonList = (value: DbParam | undefined): string[] => {
  try {
    const parsed = JSON.parse(str(value) || '[]')
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : []
  } catch {
    return []
  }
}

function announcementFromRow(row: DbRow): WelinkAnnouncement {
  return {
    pk: num(row.id),
    annUid: str(row.ann_uid),
    convPk: num(row.conv_pk),
    convId: str(row.conv_id),
    title: str(row.title),
    content: str(row.content),
    publishedAt: str(row.published_at),
    createdAt: str(row.created_at),
  }
}

function draftFromRow(row: DbRow): KnowledgeDraft {
  const status = str(row.status)
  return {
    pk: num(row.id),
    title: str(row.title),
    content: str(row.content),
    topic: str(row.topic),
    sourceType: (['message', 'announcement', 'qa'].includes(str(row.source_type))
      ? str(row.source_type)
      : 'message') as KnowledgeDraftSource,
    sourceRefs: jsonList(row.source_refs),
    contentHash: str(row.content_hash),
    status: (['pending', 'approved', 'rejected'].includes(status) ? status : 'pending') as KnowledgeDraftStatus,
    reviewNote: str(row.review_note),
    createdAt: str(row.created_at),
    reviewedAt: nullable(row.reviewed_at),
  }
}

function logFromRow(row: DbRow): SedimentLog {
  return {
    pk: num(row.id),
    prompt: str(row.prompt),
    response: str(row.response),
    status: (['ok', 'error', 'timeout'].includes(str(row.status)) ? str(row.status) : 'error') as SedimentLog['status'],
    latencyMs: num(row.latency_ms),
    error: str(row.error),
    createdAt: str(row.created_at),
  }
}

function messageFromRow(row: DbRow): WelinkMessage {
  return {
    pk: num(row.id),
    convPk: num(row.conv_pk),
    msgUid: str(row.msg_uid),
    convType: str(row.conv_type) === 'private' ? 'private' : 'group',
    convId: str(row.conv_id),
    direction: str(row.direction) === 'out' ? 'out' : 'in',
    senderId: str(row.sender_id),
    senderName: str(row.sender_name),
    content: str(row.content),
    msgType: str(row.msg_type) || 'text',
    atMe: num(row.at_me) === 1,
    readFlag: num(row.read_flag) === 1,
    sentAt: str(row.sent_at),
  }
}

// ---------------------------------------------------------------- SQL 片段

/** 公告行 + 会话 ID（消息同款：写路径只写 conv_pk，读路径联表带 conv_id） */
const ANNOUNCEMENT_SELECT = `SELECT a.id, a.ann_uid, a.conv_pk, a.title, a.content, a.published_at,
       a.created_at, c.conv_id AS conv_id
  FROM welink_announcements a JOIN welink_conversations c ON c.id = a.conv_pk`

/** 消息行 + 会话类型/ID（与 welink 仓储 MESSAGE_SELECT 同构，沉淀侧只读复用） */
const MESSAGE_SELECT = `SELECT m.id, m.conv_pk, m.msg_uid, m.direction, m.sender_id, m.sender_name,
       m.content, m.msg_type, m.at_me, m.read_flag, m.sent_at,
       c.conv_type AS conv_type, c.conv_id AS conv_id
  FROM welink_messages m JOIN welink_conversations c ON c.id = m.conv_pk`

function placeholders(count: number, offset = 0): string {
  return Array.from({ length: count }, (_, index) => `?${index + 1 + offset}`).join(', ')
}

// ---------------------------------------------------------------- 仓储实现

export const sqlSedimentRepository: SedimentRepository = {
  // ---------------- 公告 ----------------

  async applyAnnouncements(items) {
    if (!items.length) return []
    const inserted: WelinkAnnouncement[] = []
    for (const item of items) {
      const convRows = await bridge.dbSelect('SELECT id FROM welink_conversations WHERE conv_id = ?1', [item.convId])
      const convPk = num(convRows[0]?.id)
      if (!convPk) continue // 会话不存在：跳过该条目（FK 不可悬空），其余照常
      const result = await bridge.dbExecute(
        `INSERT OR IGNORE INTO welink_announcements
           (ann_uid, conv_pk, title, content, published_at, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
        [item.annUid, convPk, item.title, item.content, item.publishedAt, nowStamp()],
      )
      if (result.changes <= 0) continue // ann_uid 已存在：幂等跳过
      const rows = await bridge.dbSelect(`${ANNOUNCEMENT_SELECT} WHERE a.ann_uid = ?1`, [item.annUid])
      if (rows[0]) inserted.push(announcementFromRow(rows[0]))
    }
    return inserted
  },

  async listAnnouncements(limit, offset) {
    const rows = await bridge.dbSelect(
      `${ANNOUNCEMENT_SELECT} ORDER BY a.published_at DESC, a.id DESC LIMIT ?1 OFFSET ?2`,
      [limit, offset],
    )
    return rows.map(announcementFromRow)
  },

  async listAnnouncementsSince(afterPk, limit) {
    const rows = await bridge.dbSelect(`${ANNOUNCEMENT_SELECT} WHERE a.id > ?1 ORDER BY a.id ASC LIMIT ?2`, [
      afterPk,
      limit,
    ])
    return rows.map(announcementFromRow)
  },

  // ---------------- 待评审条目 ----------------

  async insertDrafts(drafts) {
    if (!drafts.length) return []
    const hashes = drafts.map((item) => item.contentHash)
    const known = new Set(await this.findKnownHashes(hashes))
    const fresh = drafts.filter((item) => !known.has(item.contentHash))
    if (!fresh.length) return []
    const statements = fresh.map((item) => ({
      sql: `INSERT INTO knowledge_drafts
              (title, content, topic, source_type, source_refs, content_hash, status, review_note, created_at)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'pending', '', ?7)`,
      params: [
        item.title,
        item.content,
        item.topic,
        item.sourceType,
        JSON.stringify(item.sourceRefs),
        item.contentHash,
        nowStamp(),
      ],
    }))
    await bridge.dbTransaction(statements)
    // 事务无逐行回执：按本批 hash 反查入库行（同批 hash 互不相同，语义等价）
    const rows = await bridge.dbSelect(
      `SELECT * FROM knowledge_drafts WHERE content_hash IN (${placeholders(fresh.length)})`,
      fresh.map((item) => item.contentHash),
    )
    return rows.map(draftFromRow)
  },

  async listDrafts(query) {
    const where = query.status ? `WHERE status = ?1` : ''
    const params: DbParam[] = query.status ? [query.status] : []
    const rows = await bridge.dbSelect(
      `SELECT * FROM knowledge_drafts ${where} ORDER BY created_at ASC, id ASC LIMIT ?${params.length + 1} OFFSET ?${params.length + 2}`,
      [...params, query.limit, query.offset],
    )
    return rows.map(draftFromRow)
  },

  async countDrafts(status) {
    const rows = await bridge.dbSelect(
      status
        ? 'SELECT COUNT(*) AS count FROM knowledge_drafts WHERE status = ?1'
        : 'SELECT COUNT(*) AS count FROM knowledge_drafts',
      status ? [status] : [],
    )
    return num(rows[0]?.count)
  },

  async findKnownHashes(hashes) {
    if (!hashes.length) return []
    const rows = await bridge.dbSelect(
      `SELECT content_hash FROM knowledge_drafts WHERE content_hash IN (${placeholders(hashes.length)})`,
      hashes,
    )
    return rows.map((row) => str(row.content_hash))
  },

  async approveDraft(pk, patch) {
    const result = await bridge.dbExecute(
      `UPDATE knowledge_drafts SET title = ?1, content = ?2, status = 'approved', reviewed_at = ?3
        WHERE id = ?4 AND status = 'pending'`,
      [patch.title, patch.content, nowStamp(), pk],
    )
    return result.changes > 0
  },

  async rejectDraft(pk, note) {
    const result = await bridge.dbExecute(
      `UPDATE knowledge_drafts SET status = 'rejected', review_note = ?1, reviewed_at = ?2
        WHERE id = ?3 AND status = 'pending'`,
      [note, nowStamp(), pk],
    )
    return result.changes > 0
  },

  // ---------------- 水位 ----------------

  async getState(key) {
    const rows = await bridge.dbSelect('SELECT value FROM sediment_state WHERE key = ?1', [key])
    return rows.length ? str(rows[0]?.value) : null
  },

  async setState(key, value) {
    await bridge.dbExecute(
      `INSERT INTO sediment_state (key, value) VALUES (?1, ?2)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      [key, value],
    )
  },

  // ---------------- 沉淀调用留痕 ----------------

  async insertSedimentLog(log) {
    const createdAt = nowStamp()
    const result = await bridge.dbExecute(
      `INSERT INTO sediment_logs (prompt, response, status, latency_ms, error, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
      [log.prompt, log.response, log.status, log.latencyMs, log.error, createdAt],
    )
    return { pk: num(result.lastInsertId), ...log, createdAt }
  },

  async listSedimentLogs(limit) {
    const rows = await bridge.dbSelect('SELECT * FROM sediment_logs ORDER BY id DESC LIMIT ?1', [limit])
    return rows.map(logFromRow)
  },

  async clearSedimentLogs() {
    const result = await bridge.dbExecute('DELETE FROM sediment_logs', [])
    return result.changes
  },

  // ---------------- 原料扫描（只读） ----------------

  async listInMessagesSince(afterPk, convIds, limit) {
    if (!convIds.length) return []
    const rows = await bridge.dbSelect(
      `${MESSAGE_SELECT}
        WHERE m.id > ?1 AND m.direction = 'in' AND c.conv_type = 'group'
          AND c.conv_id IN (${placeholders(convIds.length, 1)})
        ORDER BY m.id ASC LIMIT ?${convIds.length + 2}`,
      [afterPk, ...convIds, limit],
    )
    return rows.map(messageFromRow)
  },

  async listSentQaSince(afterFinishedAt, limit) {
    const rows = await bridge.dbSelect(
      `SELECT j.id, j.target_id, j.skill_id, j.skill_name, j.skill_source, j.rating, j.finished_at,
              COALESCE(m.content, '') AS question, j.draft AS answer
         FROM welink_reply_jobs j
         LEFT JOIN welink_messages m ON m.id = j.trigger_msg_pk
        WHERE j.status = 'sent' AND j.finished_at IS NOT NULL AND j.finished_at > ?1
        ORDER BY (j.rating = 'up') DESC, j.finished_at ASC, j.id ASC
        LIMIT ?2`,
      [afterFinishedAt, limit],
    )
    return rows.map((row) => ({
      pk: num(row.id),
      targetId: str(row.target_id),
      skillId: str(row.skill_id),
      skillName: str(row.skill_name),
      skillSource: str(row.skill_source),
      question: str(row.question),
      answer: str(row.answer),
      rating: str(row.rating) === 'up' || str(row.rating) === 'down' ? (str(row.rating) as 'up' | 'down') : null,
      finishedAt: str(row.finished_at),
    }))
  },
}
