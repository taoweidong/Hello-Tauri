/**
 * CodeHub 检视域仓储的内存实现（浏览器调试模式，Q3/D5：不做真 SQL）。
 *
 * 语义必须与 SQLite 实现**契约一致**（两套实现共享同一组断言的关键语义各测一遍）：
 *  * `applySnapshot` 覆盖写幂等（同 (repoId, mrIid) 只留一行）+ 同步状态同事务落 success；
 *  * `markSyncError` 只更新 last_error，保留既有 last_synced_at；
 *  * 排序口径（updated_at DESC, mr_iid DESC）与 SQL 版一致，避免 UI 抖动；
 *  * `removeRepo` 显式级联删快照与同步状态。
 */
import type { CodeHubMergeRequestDetail, CodeHubMrRecord, CodeHubRepo, CodeHubSyncState } from '@/types/codehub'
import { nowStamp } from '@/utils/time'
import type { CodeHubMrQuery, CodeHubRepository } from '../codehub-ports'

const STORAGE_KEY = 'hello-tauri:codehub'

interface MemoryMrs extends CodeHubMrRecord {
  syncedAt: string
}

interface MemoryState {
  seq: number
  repos: CodeHubRepo[]
  mrs: MemoryMrs[]
  sync: Record<string, { lastSyncedAt: string | null; lastError: string | null }>
}

function emptyState(): MemoryState {
  return { seq: 0, repos: [], mrs: [], sync: {} }
}

function load(): MemoryState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return emptyState()
    const parsed = JSON.parse(raw) as MemoryState
    if (!parsed.repos || !Array.isArray(parsed.mrs) || typeof parsed.sync !== 'object') return emptyState()
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
export function resetCodehubMemory() {
  state = emptyState()
  flush()
}

/** 与 SQL 版 `ORDER BY updated_at DESC, mr_iid DESC` 同口径 */
function descByUpdated(items: MemoryMrs[]): MemoryMrs[] {
  return [...items].sort((a, b) =>
    a.summary.updatedAt === b.summary.updatedAt
      ? b.summary.mrIid < a.summary.mrIid
        ? -1
        : 1
      : a.summary.updatedAt < b.summary.updatedAt
        ? 1
        : -1,
  )
}

/** MR 快照筛选（与 SQL 版 buildMrsWhere 同口径的内存版） */
function matchMrs(record: MemoryMrs, query: Omit<CodeHubMrQuery, 'limit' | 'offset'>): boolean {
  if (query.repoId && record.summary.repoId !== query.repoId) return false
  if (query.state && record.summary.state !== query.state) return false
  return true
}

function stripSynced(record: MemoryMrs): CodeHubMrRecord {
  return { summary: record.summary, detail: record.detail }
}

export const memoryCodehubRepository: CodeHubRepository = {
  async listRepos(limit) {
    return state.repos.slice(0, Math.max(0, limit))
  },

  async addRepo(repoId, name) {
    const existing = state.repos.find((repo) => repo.repoId === repoId)
    if (existing) {
      existing.name = name
      flush()
      return { ...existing }
    }
    state.seq += 1
    const repo: CodeHubRepo = { pk: state.seq, repoId, name, enabled: true, createdAt: nowStamp() }
    state.repos = [repo, ...state.repos]
    flush()
    return { ...repo }
  },

  async setRepoEnabled(pk, enabled) {
    const repo = state.repos.find((item) => item.pk === pk)
    if (!repo) return false
    repo.enabled = enabled
    flush()
    return true
  },

  async removeRepo(pk) {
    const repo = state.repos.find((item) => item.pk === pk)
    if (!repo) return false
    state.repos = state.repos.filter((item) => item.pk !== pk)
    state.mrs = state.mrs.filter((record) => record.summary.repoId !== repo.repoId)
    delete state.sync[repo.repoId]
    flush()
    return true
  },

  async applySnapshot(repoId, records, syncedAt) {
    for (const record of records) {
      const incoming: MemoryMrs = { summary: record.summary, detail: record.detail, syncedAt }
      const index = state.mrs.findIndex(
        (item) => item.summary.repoId === repoId && item.summary.mrIid === record.summary.mrIid,
      )
      if (index >= 0) state.mrs[index] = incoming
      else state.mrs.push(incoming)
    }
    state.sync[repoId] = { lastSyncedAt: syncedAt, lastError: null }
    flush()
    return records.length
  },

  async listMrs(query: CodeHubMrQuery) {
    return descByUpdated(state.mrs.filter((record) => matchMrs(record, query)))
      .slice(query.offset, query.offset + Math.max(0, query.limit))
      .map(stripSynced)
  },

  async countMrs(query) {
    return state.mrs.filter((record) => matchMrs(record, query)).length
  },

  async getMr(repoId, mrIid) {
    const record = state.mrs.find((item) => item.summary.repoId === repoId && item.summary.mrIid === mrIid)
    return record ? stripSynced(record) : null
  },

  async saveMrDetail(repoId, mrIid, detail: CodeHubMergeRequestDetail, syncedAt) {
    const record = state.mrs.find((item) => item.summary.repoId === repoId && item.summary.mrIid === mrIid)
    if (!record) return false
    record.detail = detail
    record.syncedAt = syncedAt
    flush()
    return true
  },

  async listSyncStates(): Promise<CodeHubSyncState[]> {
    return Object.entries(state.sync).map(([repoId, value]) => ({
      repoId,
      lastSyncedAt: value.lastSyncedAt,
      lastError: value.lastError,
    }))
  },

  async markSyncError(repoId, message) {
    const existing = state.sync[repoId]
    state.sync[repoId] = { lastSyncedAt: existing?.lastSyncedAt ?? null, lastError: message }
    flush()
  },
}
