/**
 * WeLink 仓储的内存实现（浏览器调试模式，Q3/D5：不做真 SQL）。
 *
 * 为什么要有它：`npm run dev` 必须在**没有 Rust 环境**的前提下跑通全部页面与全链路
 * （设计 §3.3 的 mock 优先策略）。语义上它必须与 SQLite 实现**契约一致** ——
 * 两套实现共享同一组端口夹具测试，任何行为漂移都会被回归测试抓到。
 *
 * 刻意简化而不失真的点：
 *  * 持久化到 localStorage（刷新不丢，便于调试多轮）；
 *  * 幂等去重、状态机并发锁、要点3 的原子性都照实现 —— 这些是被测试覆盖的语义，
 *    不能因为「反正是 mock」就省略。
 */
import type { JobRating, SkillSource, WelinkAgentLog, WelinkConversation, WelinkJob, WelinkMessage } from '@/types/welink'
import { nowStamp } from '@/utils/time'
import type {
  ApplyResult,
  InboxQuery,
  InboxThread,
  JobQuery,
  JobStats,
  MessageQuery,
  SkillAttribution,
  WelinkRepository,
} from '../ports'

const STORAGE_KEY = 'hello-tauri:welink'

interface MemoryState {
  seq: { conv: number; msg: number; job: number; log: number }
  conversations: WelinkConversation[]
  messages: WelinkMessage[]
  jobs: WelinkJob[]
  logs: WelinkAgentLog[]
}

function emptyState(): MemoryState {
  return { seq: { conv: 0, msg: 0, job: 0, log: 0 }, conversations: [], messages: [], jobs: [], logs: [] }
}

function load(): MemoryState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return emptyState()
    const parsed = JSON.parse(raw) as MemoryState
    // 结构不完整时直接重建：调试模式的数据不值得为兼容老结构付出复杂度
    if (!parsed.seq || !Array.isArray(parsed.conversations)) return emptyState()
    // 老结构 job（migration v5 之前）缺技能三列：补默认空串，读路径恒有值
    for (const job of parsed.jobs ?? []) {
      job.skillId ??= ''
      job.skillName ??= ''
      job.skillSource ??= ''
    }
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
export function resetWelinkMemory() {
  state = emptyState()
  flush()
}

/**
 * 消息与任务的只读快照（知识沉淀内存仓储的原料源）。
 *
 * 沉淀域在 SQLite 侧直接跨表只读查询 welink_messages / welink_reply_jobs（同一数据库）；
 * 浏览器调试模式下两个内存仓储各持一份 localStorage 状态，沉淀仓储通过本访问器
 * 拿到同一份内存数据，保证两实现的「原料可见性」语义一致（只读，不拷贝内部数组引用）。
 */
export function memoryRawMaterials(): {
  conversations: WelinkConversation[]
  messages: WelinkMessage[]
  jobs: WelinkJob[]
} {
  return { conversations: [...state.conversations], messages: [...state.messages], jobs: [...state.jobs] }
}

const byConvId = (convId: string) => state.conversations.find((item) => item.convId === convId)
const byConvPk = (pk: number) => state.conversations.find((item) => item.pk === pk)

/** 模拟 SQLite 的 `sent_at DESC, id DESC` 排序（内存实现也要时序稳定，否则 UI 抖动） */
function descByTime<T extends { sentAt?: string; createdAt?: string; pk: number }>(items: T[]): T[] {
  return [...items].sort((a, b) => {
    const left = a.sentAt ?? a.createdAt ?? ''
    const right = b.sentAt ?? b.createdAt ?? ''
    if (left === right) return b.pk - a.pk
    return left < right ? 1 : -1
  })
}

function touchJob(pk: number, patch: Partial<WelinkJob>): boolean {
  const job = state.jobs.find((item) => item.pk === pk)
  if (!job) return false
  Object.assign(job, patch, { updatedAt: nowStamp() })
  flush()
  return true
}

export const memoryWelinkRepository: WelinkRepository = {
  // ---------------- 会话 ----------------

  async listConversations(limit, offset) {
    return state.conversations
      .slice()
      .sort((a, b) =>
        a.convType === b.convType ? (a.lastMsgAt < b.lastMsgAt ? 1 : -1) : a.convType.localeCompare(b.convType),
      )
      .slice(offset, offset + limit)
      .map((item) => ({ ...item }))
  },

  async countConversations() {
    return state.conversations.length
  },

  async listWatching() {
    return state.conversations.filter((item) => item.watching).map((item) => ({ ...item }))
  },

  async getConversation(convId) {
    const found = byConvId(convId)
    return found ? { ...found } : null
  },

  async upsertConversation(draft) {
    const existing = byConvId(draft.convId)
    if (existing) {
      if (draft.title) existing.title = draft.title
      existing.updatedAt = nowStamp()
      flush()
      return { ...existing }
    }
    const row: WelinkConversation = {
      pk: (state.seq.conv += 1),
      convType: draft.convType,
      convId: draft.convId,
      title: draft.title ?? '',
      remark: draft.remark ?? '',
      watching: draft.watching ?? false,
      autoReply: draft.autoReply ?? false,
      muteUntil: null,
      lastMsgAt: '',
      unreadCount: 0,
      mentionCount: 0,
      lastActive: '',
      lastCursor: '',
      updatedAt: nowStamp(),
    }
    state.conversations.push(row)
    flush()
    return { ...row }
  },

  async updateConversation(convId, patch) {
    const row = byConvId(convId)
    if (!row) return
    if (patch.title !== undefined) row.title = patch.title
    if (patch.remark !== undefined) row.remark = patch.remark
    if (patch.watching !== undefined) row.watching = patch.watching
    if (patch.autoReply !== undefined) row.autoReply = patch.autoReply
    if (patch.muteUntil !== undefined) row.muteUntil = patch.muteUntil
    row.updatedAt = nowStamp()
    flush()
  },

  async setAutoReply(convIds, enabled) {
    let changed = 0
    for (const convId of convIds) {
      const row = byConvId(convId)
      if (!row) continue
      row.autoReply = enabled
      row.updatedAt = nowStamp()
      changed += 1
    }
    flush()
    return changed
  },

  async removeConversation(convId) {
    const row = byConvId(convId)
    if (!row) return
    const jobPks = state.jobs.filter((job) => job.targetId === convId).map((job) => job.pk)
    state.logs = state.logs.filter((log) => !jobPks.includes(log.jobPk))
    state.jobs = state.jobs.filter((job) => job.targetId !== convId)
    state.messages = state.messages.filter((message) => message.convPk !== row.pk)
    state.conversations = state.conversations.filter((item) => item.convId !== convId)
    flush()
  },

  // ---------------- 消息 ----------------

  async applyPollResult(convId, messages, cursor, rules) {
    const conv = byConvId(convId)
    if (!conv) throw new Error(`会话未在监控清单中：${convId}`)

    const known = new Set(state.messages.map((item) => item.msgUid))
    const fresh = messages.filter((item) => !known.has(item.msgUid))
    const inserted: WelinkMessage[] = []
    const createdJobs: WelinkJob[] = []
    const now = nowStamp()

    for (const message of fresh) {
      const row: WelinkMessage = {
        ...message,
        pk: (state.seq.msg += 1),
        convPk: conv.pk,
        readFlag: false,
      }
      state.messages.push(row)
      inserted.push({ ...row })

      const trigger = rules.triggers[message.msgUid]
      if (!trigger) continue
      const job: WelinkJob = {
        pk: (state.seq.job += 1),
        triggerMsgPk: row.pk,
        triggerType: trigger,
        targetType: message.convType,
        targetId: message.convId,
        sendModeUsed: rules.sendMode,
        contextSnapshot: '',
        draft: '',
        status: 'pending',
        attempts: 0,
        lastError: '',
        skipReason: '',
        holdReason: '',
        skillId: '',
        skillName: '',
        skillSource: '',
        rating: null,
        createdAt: now,
        updatedAt: now,
        finishedAt: null,
        triggerSummary: message.content.slice(0, 120),
        targetTitle: conv.title,
      }
      state.jobs.push(job)
      createdJobs.push({ ...job })
    }

    conv.lastCursor = cursor
    conv.lastMsgAt = fresh.reduce((latest, item) => (item.sentAt > latest ? item.sentAt : latest), conv.lastMsgAt)
    if (fresh.length) conv.lastActive = now
    conv.unreadCount += fresh.filter((item) => item.direction === 'in').length
    conv.mentionCount += fresh.filter((item) => item.atMe && item.msgType === 'text').length
    conv.updatedAt = now
    flush()

    return { inserted, createdJobs, cursor } satisfies ApplyResult
  },

  /**
   * 按主键取单条消息（S5 修复合入前，管线要用它拿触发消息的 senderId）。
   * 契约与 SQLite 实现一致：找不到返回 null，返回浅拷贝避免外部改写污染内存态。
   */
  async getMessage(pk) {
    const found = state.messages.find((message) => message.pk === pk)
    return found ? { ...found } : null
  },

  async listMessages(query: MessageQuery) {
    let rows = state.messages.filter((message) => message.convPk === query.convPk)
    const before = query.before
    if (before) rows = rows.filter((message) => message.sentAt < before)
    if (query.keyword?.trim()) {
      const kw = query.keyword.trim().toLowerCase()
      rows = rows.filter(
        (message) => message.content.toLowerCase().includes(kw) || message.senderName.toLowerCase().includes(kw),
      )
    }
    return descByTime(rows)
      .slice(0, query.limit)
      .reverse()
      .map((item) => ({ ...item }))
  },

  async searchMessages(keyword, from, to, limit, offset) {
    const kw = keyword.trim().toLowerCase()
    let rows = state.messages.filter((message) => !kw || message.content.toLowerCase().includes(kw))
    if (from) rows = rows.filter((message) => message.sentAt >= from)
    if (to) rows = rows.filter((message) => message.sentAt <= to)
    return descByTime(rows)
      .slice(offset, offset + limit)
      .map((item) => ({ ...item }))
  },

  async markRead(convPk) {
    for (const message of state.messages) {
      if (message.convPk === convPk) message.readFlag = true
    }
    const conv = byConvPk(convPk)
    if (conv) {
      conv.unreadCount = 0
      conv.mentionCount = 0
      conv.updatedAt = nowStamp()
    }
    flush()
  },

  async recentContext(convPk, maxN) {
    return descByTime(state.messages.filter((message) => message.convPk === convPk))
      .slice(0, Math.max(1, maxN))
      .reverse()
      .map((item) => ({ ...item }))
  },

  async listInbox(query: InboxQuery) {
    const threads = buildThreads(query)
    return threads.slice(query.offset, query.offset + query.limit)
  },

  async countInbox(query) {
    return buildThreads(query).length
  },

  // ---------------- 回复任务 ----------------

  async createJob(draft) {
    const now = nowStamp()
    const conv = byConvId(draft.targetId)
    // 与 SQLite 实现同语义：优先按 msgUid 回查触发消息（跨重启恢复时主键已不可信）
    const message =
      state.messages.find((item) => item.msgUid === draft.triggerMsgUid) ??
      state.messages.find((item) => item.pk === draft.triggerMsgPk)
    const job: WelinkJob = {
      pk: (state.seq.job += 1),
      triggerMsgPk: message?.pk ?? draft.triggerMsgPk,
      triggerType: draft.triggerType,
      targetType: draft.targetType,
      targetId: draft.targetId,
      sendModeUsed: draft.sendModeUsed,
      contextSnapshot: draft.contextSnapshot,
      draft: '',
      status: 'pending',
      attempts: 0,
      lastError: '',
      skipReason: '',
      holdReason: '',
      skillId: '',
      skillName: '',
      skillSource: '',
      rating: null,
      createdAt: now,
      updatedAt: now,
      finishedAt: null,
      triggerSummary: message?.content.slice(0, 120) ?? '',
      targetTitle: conv?.title ?? '',
    }
    state.jobs.push(job)
    flush()
    return { ...job }
  },

  async getJob(pk) {
    const job = state.jobs.find((item) => item.pk === pk)
    return job ? { ...job } : null
  },

  async listJobsByStatus(status, limit) {
    return state.jobs
      .filter((job) => !status.length || status.includes(job.status))
      .sort((a, b) => (a.createdAt === b.createdAt ? a.pk - b.pk : a.createdAt < b.createdAt ? -1 : 1))
      .slice(0, limit)
      .map((item) => ({ ...item }))
  },

  async listUnfinishedJobs() {
    return state.jobs
      .filter((job) => ['pending', 'discussing', 'ready', 'sending', 'failed'].includes(job.status))
      .sort((a, b) => (a.createdAt === b.createdAt ? a.pk - b.pk : a.createdAt < b.createdAt ? -1 : 1))
      .map((item) => ({ ...item }))
  },

  async listJobs(query: JobQuery) {
    return filterJobs(query)
      .sort((a, b) => (a.createdAt === b.createdAt ? b.pk - a.pk : a.createdAt < b.createdAt ? 1 : -1))
      .slice(query.offset, query.offset + query.limit)
      .map((item) => ({ ...item }))
  },

  async countJobs(query) {
    return filterJobs(query).length
  },

  async jobStats(dayStart, hourStart) {
    const all = state.jobs
    const sent = all.filter((job) => job.status === 'sent')
    const failed = all.filter((job) => job.status === 'failed')
    const attempted = sent.length + failed.length
    const latencies = sent
      .map((job) => (new Date(job.finishedAt ?? '').getTime() - new Date(job.createdAt).getTime()) / 1000 || 0)
      .filter((value) => Number.isFinite(value))
    void hourStart
    return {
      todayCount: all.filter((job) => job.createdAt >= dayStart).length,
      sentCount: sent.length,
      failedCount: failed.length,
      successRate: attempted ? sent.length / attempted : 1,
      avgLatencySec: latencies.length ? Math.round(latencies.reduce((sum, v) => sum + v, 0) / latencies.length) : 0,
      skippedCount: all.filter((job) => job.status === 'skipped').length,
    } satisfies JobStats
  },

  async markStatus(pk, status, expect) {
    const job = state.jobs.find((item) => item.pk === pk)
    if (!job) return false
    if (expect && job.status !== expect) return false
    touchJob(pk, { status })
    return true
  },

  async commitDraft(pk, draft, contextSnapshot, skill?: SkillAttribution) {
    const job = state.jobs.find((item) => item.pk === pk)
    // 与 SQLite 实现同语义：仅 discussing 可提交，且 draft 与 ready 一起生效；
    // 技能三列同条写入（skill-routing D5，与 SQL 实现的原子口径一致）
    if (!job || job.status !== 'discussing') return false
    touchJob(pk, {
      draft,
      status: 'ready',
      holdReason: '',
      ...(contextSnapshot === undefined ? {} : { contextSnapshot }),
      ...(skill ? { skillId: skill.id, skillName: skill.name, skillSource: skill.source as SkillSource } : {}),
    })
    return true
  },

  async recordAttemptFailure(pk, status, error) {
    const job = state.jobs.find((item) => item.pk === pk)
    if (!job) return
    job.attempts += 1
    job.lastError = error.slice(0, 500)
    job.status = status
    if (status === 'failed' || status === 'skipped') job.finishedAt = nowStamp()
    job.updatedAt = nowStamp()
    flush()
  },

  async requeueJob(pk) {
    const job = state.jobs.find((item) => item.pk === pk)
    if (!job || !['failed', 'skipped', 'ready'].includes(job.status)) return false
    touchJob(pk, { status: 'ready', skipReason: '', holdReason: '', lastError: '', finishedAt: null })
    return true
  },

  async skipJob(pk, reason) {
    const job = state.jobs.find((item) => item.pk === pk)
    if (!job || !['ready', 'pending', 'discussing'].includes(job.status)) return
    touchJob(pk, { status: 'skipped', skipReason: String(reason), finishedAt: nowStamp() })
  },

  async holdJob(pk, reason) {
    const job = state.jobs.find((item) => item.pk === pk)
    if (!job || !['ready', 'pending', 'discussing', 'sending'].includes(job.status)) return
    touchJob(pk, { status: 'ready', holdReason: String(reason), finishedAt: null })
  },

  async suspendJob(pk) {
    const job = state.jobs.find((item) => item.pk === pk)
    if (!job || !['ready', 'sending'].includes(job.status)) return
    touchJob(pk, { status: 'ready', holdReason: '', finishedAt: null })
  },

  async updateDraft(pk, draft) {
    touchJob(pk, { draft, holdReason: '' })
  },

  async rateJob(pk, rating: JobRating | null) {
    touchJob(pk, { rating })
  },

  /** 与 SQLite 同语义：只删任务与其留痕，触发消息与会话保留 */
  async removeJob(pk) {
    const before = state.jobs.length
    const hadLogs = state.logs.some((log) => log.jobPk === pk)
    state.logs = state.logs.filter((log) => log.jobPk !== pk)
    state.jobs = state.jobs.filter((job) => job.pk !== pk)
    flush()
    return state.jobs.length < before || hadLogs
  },

  async markSent(pk, receipt) {
    const job = state.jobs.find((item) => item.pk === pk)
    if (!job || job.status !== 'sending') return false
    touchJob(pk, { status: 'sent', finishedAt: receipt.sentAt, lastError: '' })
    // 幂等回写 out 消息（与 SQLite 的 INSERT OR IGNORE 同语义）
    if (!state.messages.some((item) => item.msgUid === receipt.msgUid)) {
      state.messages.push({
        pk: (state.seq.msg += 1),
        convPk: receipt.convPk,
        msgUid: receipt.msgUid,
        convType: job.targetType,
        convId: job.targetId,
        direction: 'out',
        senderId: '',
        senderName: '',
        content: receipt.content,
        msgType: 'text',
        atMe: false,
        readFlag: true,
        sentAt: receipt.sentAt,
      })
    }
    const conv = byConvPk(receipt.convPk)
    if (conv) conv.lastMsgAt = receipt.sentAt
    flush()
    return true
  },

  async hasOutgoingReceipt(pk) {
    const job = state.jobs.find((item) => item.pk === pk)
    if (!job) return false
    const conv = byConvId(job.targetId)
    if (!conv) return false
    return state.messages.some(
      (message) => message.convPk === conv.pk && message.direction === 'out' && message.content === job.draft,
    )
  },

  async countHolding() {
    return state.jobs.filter((job) => job.status === 'ready' && job.holdReason !== '').length
  },

  async countSentSince(targetId, since) {
    return state.jobs.filter(
      (job) => job.targetId === targetId && job.status === 'sent' && (job.finishedAt ?? '') >= since,
    ).length
  },

  /** 该会话最近一次成功外发时间（S1 会话最小间隔的内存实现） */
  async lastSentAt(targetId) {
    const sent = state.jobs
      .filter((job) => job.targetId === targetId && job.status === 'sent' && job.finishedAt)
      .sort((a, b) => ((a.finishedAt ?? '') < (b.finishedAt ?? '') ? 1 : -1))
    return sent[0]?.finishedAt ?? null
  },

  async countGlobalSentSince(since) {
    return state.jobs.filter((job) => job.status === 'sent' && (job.finishedAt ?? '') >= since).length
  },

  // ---------------- Agent 留痕 ----------------

  async insertAgentLog(log) {
    const seq = state.logs.filter((item) => item.jobPk === log.jobPk).length + 1
    const row: WelinkAgentLog = {
      pk: (state.seq.log += 1),
      jobPk: log.jobPk,
      seq,
      prompt: log.prompt,
      response: log.response,
      status: log.status,
      latencyMs: log.latencyMs,
      error: log.error,
      createdAt: nowStamp(),
    }
    state.logs.push(row)
    flush()
    return { ...row }
  },

  async listAgentLogs(jobPk) {
    return state.logs
      .filter((item) => item.jobPk === jobPk)
      .sort((a, b) => a.seq - b.seq)
      .map((item) => ({ ...item }))
  },

  async listJobsWithLogs(limit, offset, onlyDownRated) {
    return matchJobsWithLogs(onlyDownRated)
      .sort((a, b) => (a.createdAt === b.createdAt ? b.pk - a.pk : a.createdAt < b.createdAt ? 1 : -1))
      .slice(offset, offset + limit)
      .map((item) => ({ ...item }))
  },

  async countJobsWithLogs(onlyDownRated) {
    return matchJobsWithLogs(onlyDownRated).length
  },

  async clearAgentLogs(jobPk) {
    const before = state.logs.length
    state.logs = state.logs.filter((log) => log.jobPk !== jobPk)
    flush()
    return before - state.logs.length
  },

  // ---------------- 维护 ----------------

  async purgeMessagesBefore(cutoff, batch) {
    const doomed = state.messages
      .filter((message) => message.sentAt < cutoff)
      .slice(0, batch)
      .map((m) => m.pk)
    state.messages = state.messages.filter((message) => !doomed.includes(message.pk))
    flush()
    return doomed.length
  },

  async purgeAgentLogsBefore(cutoff, batch) {
    // 与 SQLite 侧同口径：按 created_at 升序取一批，删满 batch 即返回，
    // 由调度器循环调用直到返回 0，避免一次删太多把持久化拖长。
    const doomed = state.logs
      .filter((log) => log.createdAt < cutoff)
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.pk - b.pk))
      .slice(0, batch)
      .map((log) => log.pk)
    state.logs = state.logs.filter((log) => !doomed.includes(log.pk))
    flush()
    return doomed.length
  },

  async countMessages(convPk) {
    return state.messages.filter((message) => message.convPk === convPk).length
  },

  async countUnrepliedThreads() {
    const open = new Set(
      state.jobs
        .filter((job) => ['pending', 'discussing', 'ready', 'sending', 'failed'].includes(job.status))
        .map((job) => job.targetId),
    )
    return state.conversations.filter((conv) => conv.convType === 'private' && open.has(conv.convId)).length
  },
}

/** 与 SQLite 的 EXISTS(welink_agent_logs) 同语义：只取有调用留痕的任务（列表与计数共用） */
function matchJobsWithLogs(onlyDownRated: boolean): WelinkJob[] {
  const pks = new Set(state.logs.map((log) => log.jobPk))
  return state.jobs.filter((job) => pks.has(job.pk) && (!onlyDownRated || job.rating === 'down'))
}

/** 收件箱分组（列表与计数共用，保证口径一致） */
function buildThreads(query: Omit<InboxQuery, 'limit' | 'offset'>): InboxThread[] {
  const kw = query.keyword?.trim().toLowerCase() ?? ''
  const openTargets = new Set(
    state.jobs
      .filter((job) => ['pending', 'discussing', 'ready', 'sending', 'failed'].includes(job.status))
      .map((job) => job.targetId),
  )
  /** 范围内（方向 + 日期）的 in 消息 —— 与 SQLite 侧 EXISTS 的口径一一对应 */
  const incomingOf = (convPk: number) =>
    state.messages
      .filter((message) => message.convPk === convPk && message.direction === 'in')
      .filter((message) => !query.from || message.sentAt >= query.from)
      .filter((message) => !query.to || message.sentAt <= query.to)

  return (
    state.conversations
      .filter((conv) => conv.convType === 'private')
      // **必须**在范围内有过 in 消息才进收件箱 —— 与 SQLite 的 EXISTS 同口径。
      // 原实现在 onlyUnreplied=false 时把这条检查关掉了（条件写反），
      // 于是「只发出过 out」或「in 消息全在筛选区间之外」的会话也会出现，
      // 预览却是空的 —— 桌面端（SQLite）不会出现，只有浏览器调试模式会。
      .filter((conv) => incomingOf(conv.pk).length > 0)
      .filter((conv) => !kw || conv.title.toLowerCase().includes(kw) || conv.convId.toLowerCase().includes(kw))
      .filter((conv) => !query.onlyUnreplied || openTargets.has(conv.convId))
      .map((conv) => ({
        convPk: conv.pk,
        convId: conv.convId,
        title: conv.title || conv.convId,
        unreadCount: conv.unreadCount,
        lastMsgAt: conv.lastMsgAt,
        lastContent: descByTime(incomingOf(conv.pk))[0]?.content ?? '',
      }))
      .sort((a, b) => (a.lastMsgAt === b.lastMsgAt ? b.convPk - a.convPk : a.lastMsgAt < b.lastMsgAt ? 1 : -1))
  )
}

/** 回复历史筛选（与 SQLite 的 buildJobWhere 一一对应） */
function filterJobs(query: Omit<JobQuery, 'limit' | 'offset'>): WelinkJob[] {
  return state.jobs.filter((job) => {
    if (query.status?.length && !query.status.includes(job.status)) return false
    if (query.triggerType?.length && !query.triggerType.includes(job.triggerType)) return false
    if (query.targetId && job.targetId !== query.targetId) return false
    if (query.onlySkipped && !job.skipReason) return false
    if (query.onlyHolding && !(job.holdReason && job.status === 'ready')) return false
    if (query.onlyDownRated && job.rating !== 'down') return false
    if (query.from && job.createdAt < query.from) return false
    if (query.to && job.createdAt > query.to) return false
    return true
  })
}
