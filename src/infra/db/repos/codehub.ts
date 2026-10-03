/**
 * CodeHub 检视域三表仓储（SQLite 实现，业务 SQL 全在这里 —— 与 `welink-group.ts` 同构）。
 *
 * 本文件只做三件事：拼 SQL、绑参数、把行映射成类型化对象。三条不变量：
 *  1. **分页强制**（P7）：`listRepos` / `listMrs` 的 SQL 必含 `LIMIT`；
 *  2. **快照覆盖写**：`applySnapshot` 用 `ON CONFLICT(repo_id, mr_iid)` upsert，
 *     整批与同步状态 success 落在**同一个事务**里，失败整体回滚；
 *  3. **列表与计数同口径**：`listMrs` 与 `countMrs` 共用同一个 WHERE 构造器。
 */
import { bridge } from '@/api'
import type { DbParam, DbRow } from '@/types'
import type {
  CodeHubComment,
  CodeHubMergeRequestDetail,
  CodeHubMrRecord,
  CodeHubMrState,
  CodeHubRepo,
  CodeHubReviewSummary,
  CodeHubSyncState,
} from '@/types/codehub'
import { nowStamp } from '@/utils/time'
import type { CodeHubMrQuery, CodeHubRepository } from '../codehub-ports'

// ---------------------------------------------------------------- 行映射

const str = (value: DbParam | undefined): string => (value === null || value === undefined ? '' : String(value))
const num = (value: DbParam | undefined): number => Number(value ?? 0)

function reviewFromRow(row: DbRow): CodeHubReviewSummary {
  let reviewers: string[] = []
  try {
    const parsed: unknown = JSON.parse(str(row.reviewers) || '[]')
    if (Array.isArray(parsed)) reviewers = parsed.filter((item): item is string => typeof item === 'string')
  } catch {
    reviewers = [] // 快照数据损坏宁可不显示检视人，也不让列表崩
  }
  return {
    reviewers,
    approvals: num(row.approvals),
    unresolved: num(row.unresolved),
    lastActivityAt: str(row.last_activity_at),
  }
}

function detailFromRow(row: DbRow): CodeHubMergeRequestDetail | null {
  const raw = row.detail_json
  if (raw === null || raw === undefined) return null
  try {
    const parsed: unknown = JSON.parse(String(raw))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    const record = parsed as Record<string, unknown>
    const comments = Array.isArray(record.comments) ? (record.comments as CodeHubComment[]) : []
    return { description: typeof record.description === 'string' ? record.description : '', comments }
  } catch {
    return null
  }
}

function repoFromRow(row: DbRow): CodeHubRepo {
  return {
    pk: num(row.id),
    repoId: str(row.repo_id),
    name: str(row.name),
    enabled: num(row.enabled) === 1,
    createdAt: str(row.created_at),
  }
}

function mrFromRow(row: DbRow): CodeHubMrRecord {
  return {
    summary: {
      repoId: str(row.repo_id),
      mrIid: str(row.mr_iid),
      title: str(row.title),
      state: str(row.state) as CodeHubMrState,
      author: str(row.author),
      sourceBranch: str(row.source_branch),
      targetBranch: str(row.target_branch),
      updatedAt: str(row.updated_at),
      webUrl: str(row.web_url),
      review: reviewFromRow(row),
    },
    detail: detailFromRow(row),
  }
}

// ---------------------------------------------------------------- WHERE 构造

/** 组合 SELECT + WHERE + ORDER BY + LIMIT/OFFSET（与 welink-group 的 paged 同款） */
function paged(select: string, where: string, params: DbParam[], orderBy: string, limit: number, offset: number) {
  const sql = `${select} ${where} ${orderBy} LIMIT ?${params.length + 1} OFFSET ?${params.length + 2}`
  return { sql, params: [...params, limit, offset] }
}

/** MR 快照 WHERE 构造（`listMrs` 与 `countMrs` **共用**，筛选口径不漂移） */
function buildMrsWhere(query: Omit<CodeHubMrQuery, 'limit' | 'offset'>): { where: string; params: DbParam[] } {
  const clauses: string[] = []
  const params: DbParam[] = []
  if (query.repoId) {
    params.push(query.repoId)
    clauses.push(`repo_id = ?${params.length}`)
  }
  if (query.state) {
    params.push(query.state)
    clauses.push(`state = ?${params.length}`)
  }
  return { where: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', params }
}

const REPO_COLUMNS = `id, repo_id, name, enabled, created_at`
const MR_COLUMNS = `repo_id, mr_iid, title, state, author, source_branch, target_branch, updated_at, web_url, reviewers, approvals, unresolved, last_activity_at, detail_json, synced_at`

// ---------------------------------------------------------------- 语句构造

function upsertMrStatement(
  repoId: string,
  record: CodeHubMrRecord,
  syncedAt: string,
): { sql: string; params: DbParam[] } {
  const summary = record.summary
  return {
    sql: `INSERT INTO codehub_mrs
          (repo_id, mr_iid, title, state, author, source_branch, target_branch, updated_at, web_url,
           reviewers, approvals, unresolved, last_activity_at, detail_json, synced_at)
          VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)
          ON CONFLICT(repo_id, mr_iid) DO UPDATE SET
            title = excluded.title, state = excluded.state, author = excluded.author,
            source_branch = excluded.source_branch, target_branch = excluded.target_branch,
            updated_at = excluded.updated_at, web_url = excluded.web_url, reviewers = excluded.reviewers,
            approvals = excluded.approvals, unresolved = excluded.unresolved,
            last_activity_at = excluded.last_activity_at, detail_json = excluded.detail_json,
            synced_at = excluded.synced_at`,
    params: [
      repoId,
      summary.mrIid,
      summary.title,
      summary.state,
      summary.author,
      summary.sourceBranch,
      summary.targetBranch,
      summary.updatedAt,
      summary.webUrl,
      JSON.stringify(summary.review.reviewers),
      summary.review.approvals,
      summary.review.unresolved,
      summary.review.lastActivityAt,
      record.detail ? JSON.stringify(record.detail) : null,
      syncedAt,
    ],
  }
}

/** 同步成功：盖 last_synced_at 并**清空** last_error */
function syncSuccessStatement(repoId: string, syncedAt: string): { sql: string; params: DbParam[] } {
  return {
    sql: `INSERT INTO codehub_sync_state (repo_id, last_synced_at, last_error) VALUES (?1, ?2, NULL)
          ON CONFLICT(repo_id) DO UPDATE SET last_synced_at = excluded.last_synced_at, last_error = NULL`,
    params: [repoId, syncedAt],
  }
}

// ---------------------------------------------------------------- 仓储实现

export const sqlCodehubRepository: CodeHubRepository = {
  // ---------------- 仓库注册 ----------------

  async listRepos(limit) {
    const rows = await bridge.dbSelect(`SELECT ${REPO_COLUMNS} FROM codehub_repos ORDER BY id DESC LIMIT ?1`, [limit])
    return rows.map(repoFromRow)
  },

  async addRepo(repoId, name) {
    await bridge.dbExecute(
      `INSERT INTO codehub_repos (repo_id, name, created_at) VALUES (?1, ?2, ?3)
       ON CONFLICT(repo_id) DO UPDATE SET name = excluded.name`,
      [repoId, name, nowStamp()],
    )
    const rows = await bridge.dbSelect(`SELECT ${REPO_COLUMNS} FROM codehub_repos WHERE repo_id = ?1`, [repoId])
    if (!rows[0]) throw new Error(`仓库注册写入后仍读取不到：${repoId}`)
    return repoFromRow(rows[0])
  },

  async setRepoEnabled(pk, enabled) {
    const result = await bridge.dbExecute('UPDATE codehub_repos SET enabled = ?2 WHERE id = ?1', [pk, enabled ? 1 : 0])
    return result.changes > 0
  },

  async removeRepo(pk) {
    // 显式级联：不依赖宿主 PRAGMA foreign_keys 的开启状态，删不干净比删多更糟
    const rows = await bridge.dbSelect('SELECT repo_id FROM codehub_repos WHERE id = ?1', [pk])
    const repoId = rows[0] ? str(rows[0].repo_id) : ''
    if (!repoId) return false
    await bridge.dbTransaction([
      { sql: 'DELETE FROM codehub_mrs WHERE repo_id = ?1', params: [repoId] },
      { sql: 'DELETE FROM codehub_sync_state WHERE repo_id = ?1', params: [repoId] },
      { sql: 'DELETE FROM codehub_repos WHERE id = ?1', params: [pk] },
    ])
    return true
  },

  // ---------------- MR 快照 ----------------

  async applySnapshot(repoId, records, syncedAt) {
    // 整批 upsert + 同步状态 success 在同一事务：任一失败整体回滚，不留半批中间态
    const statements = [
      ...records.map((record) => upsertMrStatement(repoId, record, syncedAt)),
      syncSuccessStatement(repoId, syncedAt),
    ]
    await bridge.dbTransaction(statements)
    return records.length
  },

  async listMrs(query: CodeHubMrQuery) {
    const { where, params } = buildMrsWhere(query)
    const { sql, params: all } = paged(
      `SELECT ${MR_COLUMNS} FROM codehub_mrs`,
      where,
      params,
      'ORDER BY updated_at DESC, mr_iid DESC',
      query.limit,
      query.offset,
    )
    const rows = await bridge.dbSelect(sql, all)
    return rows.map(mrFromRow)
  },

  async countMrs(query) {
    const { where, params } = buildMrsWhere(query)
    const rows = await bridge.dbSelect(`SELECT COUNT(*) AS count FROM codehub_mrs ${where}`, params)
    return num(rows[0]?.count)
  },

  async getMr(repoId, mrIid) {
    const rows = await bridge.dbSelect(`SELECT ${MR_COLUMNS} FROM codehub_mrs WHERE repo_id = ?1 AND mr_iid = ?2`, [
      repoId,
      mrIid,
    ])
    return rows[0] ? mrFromRow(rows[0]) : null
  },

  async saveMrDetail(repoId, mrIid, detail, syncedAt) {
    const result = await bridge.dbExecute(
      `UPDATE codehub_mrs SET detail_json = ?3, synced_at = ?4 WHERE repo_id = ?1 AND mr_iid = ?2`,
      [repoId, mrIid, JSON.stringify(detail), syncedAt],
    )
    return result.changes > 0
  },

  // ---------------- 同步状态 ----------------

  async listSyncStates() {
    const rows = await bridge.dbSelect('SELECT repo_id, last_synced_at, last_error FROM codehub_sync_state')
    return rows.map((row): CodeHubSyncState => ({
      repoId: str(row.repo_id),
      lastSyncedAt: row.last_synced_at === null || row.last_synced_at === undefined ? null : str(row.last_synced_at),
      lastError: row.last_error === null || row.last_error === undefined ? null : str(row.last_error),
    }))
  },

  async markSyncError(repoId, message) {
    // 只更新 last_error：保留既有 last_synced_at（旧快照仍然可读，UI 据此标注「非实时」）
    await bridge.dbExecute(
      `INSERT INTO codehub_sync_state (repo_id, last_synced_at, last_error) VALUES (?1, NULL, ?2)
       ON CONFLICT(repo_id) DO UPDATE SET last_error = excluded.last_error`,
      [repoId, message],
    )
  },
}
