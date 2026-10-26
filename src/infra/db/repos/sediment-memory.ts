/**
 * 知识沉淀域仓储的内存实现（浏览器调试模式，Q3/D5：不做真 SQL）。
 *
 * 语义必须与 SQLite 实现**契约一致**（两套实现共享同一组契约测试）：
 *  * 公告 `ann_uid` 幂等（重复批写不产生新行）；
 *  * 条目 `content_hash` 入库前预检（重复知识不重复入库）；
 *  * 评审闸单向流（approve/reject 只对 pending 生效）；
 *  * 原料扫描经 `memoryRawMaterials()` 只读 welink 内存状态（对齐 SQL 侧跨表只读）。
 */
import type { WelinkMessage } from '@/types/welink'
import { nowStamp } from '@/utils/time'
import { maskSecrets } from '@/utils/logger'
import { memoryRawMaterials } from './welink-memory'
import type {
  KnowledgeDraft,
  SedimentLog,
  SedimentLogInput,
  SedimentRepository,
  SentQaRecord,
  WelinkAnnouncement,
} from '../sediment-ports'

const STORAGE_KEY = 'hello-tauri:sediment'

interface MemoryState {
  seq: { ann: number; draft: number; log: number }
  announcements: WelinkAnnouncement[]
  drafts: KnowledgeDraft[]
  logs: SedimentLog[]
  kv: Record<string, string>
}

function emptyState(): MemoryState {
  return { seq: { ann: 0, draft: 0, log: 0 }, announcements: [], drafts: [], logs: [], kv: {} }
}

function load(): MemoryState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return emptyState()
    const parsed = JSON.parse(raw) as MemoryState
    if (!parsed.seq || !Array.isArray(parsed.announcements)) return emptyState()
    return parsed
  } catch {
    return emptyState()
  }
}

let state: MemoryState = typeof localStorage === 'undefined' ? emptyState() : load()

function flush() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
  } catch {
    // 配额异常只影响调试模式的持久性，静默
  }
}

/** 测试与视图重置用 */
export function resetSedimentMemory() {
  state = emptyState()
  flush()
}

export const memorySedimentRepository: SedimentRepository = {
  // ---------------- 公告 ----------------

  async applyAnnouncements(items) {
    const { conversations } = memoryRawMaterials()
    const inserted: WelinkAnnouncement[] = []
    for (const item of items) {
      if (state.announcements.some((row) => row.annUid === item.annUid)) continue
      const conv = conversations.find((row) => row.convId === item.convId)
      if (!conv) continue // 会话不存在：跳过该条目（对齐 SQL 侧 FK 语义），其余照常
      const record: WelinkAnnouncement = {
        pk: (state.seq.ann += 1),
        annUid: item.annUid,
        convPk: conv.pk,
        convId: item.convId,
        title: item.title,
        content: item.content,
        publishedAt: item.publishedAt,
        createdAt: nowStamp(),
      }
      state.announcements.push(record)
      inserted.push(record)
    }
    flush()
    return inserted
  },

  async listAnnouncements(limit, offset) {
    const sorted = [...state.announcements].sort((a, b) => b.publishedAt.localeCompare(a.publishedAt) || b.pk - a.pk)
    return sorted.slice(offset, offset + limit)
  },

  async listAnnouncementsSince(afterPk, limit) {
    return state.announcements
      .filter((row) => row.pk > afterPk)
      .sort((a, b) => a.pk - b.pk)
      .slice(0, limit)
  },

  // ---------------- 待评审条目 ----------------

  async insertDrafts(drafts) {
    const inserted: KnowledgeDraft[] = []
    for (const item of drafts) {
      if (state.drafts.some((row) => row.contentHash === item.contentHash)) continue
      const record: KnowledgeDraft = {
        pk: (state.seq.draft += 1),
        title: item.title,
        content: item.content,
        topic: item.topic,
        sourceType: item.sourceType,
        sourceRefs: [...item.sourceRefs],
        contentHash: item.contentHash,
        status: 'pending',
        reviewNote: '',
        createdAt: nowStamp(),
        reviewedAt: null,
      }
      state.drafts.push(record)
      inserted.push(record)
    }
    flush()
    return inserted
  },

  async listDrafts(query) {
    const matched = state.drafts.filter((row) => !query.status || row.status === query.status)
    matched.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.pk - b.pk)
    return matched
      .slice(query.offset, query.offset + query.limit)
      .map((row) => ({ ...row, sourceRefs: [...row.sourceRefs] }))
  },

  async countDrafts(status) {
    return state.drafts.filter((row) => !status || row.status === status).length
  },

  async findKnownHashes(hashes) {
    const known = new Set(state.drafts.map((row) => row.contentHash))
    return hashes.filter((hash) => known.has(hash))
  },

  async approveDraft(pk, patch) {
    const row = state.drafts.find((item) => item.pk === pk && item.status === 'pending')
    if (!row) return false
    row.title = patch.title
    row.content = patch.content
    row.status = 'approved'
    row.reviewedAt = nowStamp()
    flush()
    return true
  },

  async rejectDraft(pk, note) {
    const row = state.drafts.find((item) => item.pk === pk && item.status === 'pending')
    if (!row) return false
    row.status = 'rejected'
    row.reviewNote = note
    row.reviewedAt = nowStamp()
    flush()
    return true
  },

  // ---------------- 水位 ----------------

  async getState(key) {
    return state.kv[key] ?? null
  },

  async setState(key, value) {
    state.kv[key] = value
    flush()
  },

  // ---------------- 沉淀调用留痕 ----------------

  async insertSedimentLog(log: SedimentLogInput) {
    // 与 SQLite 实现同一口径：落库前遮蔽（错误串可能来自 Agent 的 HTTP 响应回显）
    const record: SedimentLog = {
      pk: (state.seq.log += 1),
      ...log,
      error: maskSecrets(log.error ?? ''),
      createdAt: nowStamp(),
    }
    state.logs.push(record)
    flush()
    return record
  },

  async listSedimentLogs(limit) {
    return [...state.logs].sort((a, b) => b.pk - a.pk).slice(0, limit)
  },

  async purgeSedimentLogsBefore(cutoff, batch) {
    // 与 SQLite 实现同构：按 created_at 分批删（字符串时间戳可直接比较）
    const doomed = state.logs.filter((log) => log.createdAt < cutoff).slice(0, batch)
    if (!doomed.length) return 0
    state.logs = state.logs.filter((log) => !doomed.includes(log))
    flush()
    return doomed.length
  },

  async purgeAnnouncementsBefore(cutoff, batch) {
    // 与 SQLite 实现同构：按 createdAt 分批删（字符串时间戳可直接比较）
    const doomed = state.announcements.filter((row) => row.createdAt < cutoff).slice(0, batch)
    if (!doomed.length) return 0
    state.announcements = state.announcements.filter((row) => !doomed.includes(row))
    flush()
    return doomed.length
  },

  async purgeKnowledgeDraftsBefore(cutoff, batch) {
    // 与 SQLite 实现同构：只清已决状态、按 reviewedAt 分批删。
    // pending 的 reviewedAt 为 null，天然不匹配 `< cutoff`（显式判空对齐 SQL 侧语义）。
    const doomed = state.drafts
      .filter((row) => row.status !== 'pending' && row.reviewedAt !== null && row.reviewedAt < cutoff)
      .slice(0, batch)
    if (!doomed.length) return 0
    state.drafts = state.drafts.filter((row) => !doomed.includes(row))
    flush()
    return doomed.length
  },

  // ---------------- 原料扫描（只读 welink 内存状态） ----------------

  async listInMessagesSince(afterPk, convIds, limit) {
    if (!convIds.length) return []
    const whitelist = new Set(convIds)
    const messages: WelinkMessage[] = memoryRawMaterials()
      .messages.filter(
        (message) =>
          message.pk > afterPk &&
          message.direction === 'in' &&
          message.convType === 'group' &&
          whitelist.has(message.convId),
      )
      .sort((a, b) => a.pk - b.pk)
      .slice(0, limit)
    return messages
  },

  async listSentQaSince(afterFinishedAt, afterId, limit) {
    const { jobs, messages } = memoryRawMaterials()
    const rows: SentQaRecord[] = []
    for (const job of jobs) {
      if (job.status !== 'sent' || !job.finishedAt) continue
      // 复合游标（与 SQL 实现同口径）：同秒并列的记录靠 id 区分，不能被吃掉
      if (job.finishedAt < afterFinishedAt) continue
      if (job.finishedAt === afterFinishedAt && job.pk <= afterId) continue
      const trigger = messages.find((message) => message.pk === job.triggerMsgPk)
      rows.push({
        pk: job.pk,
        targetId: job.targetId,
        skillId: job.skillId,
        skillName: job.skillName,
        skillSource: job.skillSource,
        question: trigger?.content ?? '',
        answer: job.draft,
        rating: job.rating,
        finishedAt: job.finishedAt,
      })
    }
    // 必须与复合游标同序且单调（见 sediment-ports 的契约注释）
    rows.sort((a, b) => {
      if (a.finishedAt !== b.finishedAt) return a.finishedAt.localeCompare(b.finishedAt)
      return a.pk - b.pk
    })
    return rows.slice(0, limit)
  },
}
