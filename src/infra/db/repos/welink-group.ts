/**
 * 快速建群两表仓储（SQLite 实现，业务 SQL 全在这里 —— 与 `welink.ts` 同构）。
 *
 * 本文件只做三件事：拼 SQL、绑参数、把行映射成类型化对象。三条不变量：
 *  1. **分页强制**（P7）：`listTemplates` / `listJobs` 的 SQL 必含 `LIMIT`；
 *  2. **先留痕后外呼**：`createJob` 只产出 pending；`completeJob` / `failJob`
 *     都带 `WHERE status='pending'` 原子守卫 —— 启动清扫与外呼回写并发时后到者不覆盖；
 *  3. **列表与计数同口径**：`listJobs` 与 `countJobs` 共用同一个 WHERE 构造器。
 */
import { bridge } from '@/api'
import type { DbParam, DbRow } from '@/types'
import type { GroupJob, GroupJobDraft, GroupJobStatus, GroupTemplate, GroupTemplateDraft } from '@/types/welink'
import { decodeMemberIds, encodeMemberIds } from '@/types/welink'
import { nowStamp } from '@/utils/time'
import type { GroupJobQuery, GroupRepository } from '../group-ports'

// ---------------------------------------------------------------- 行映射

const str = (value: DbParam | undefined): string => (value === null || value === undefined ? '' : String(value))
const num = (value: DbParam | undefined): number => Number(value ?? 0)
/** 可空文本列：空串与 null 都归一为 null（`finished_at` 的语义） */
const nullable = (value: DbParam | undefined): string | null => {
  const text = str(value)
  return text ? text : null
}

function templateFromRow(row: DbRow): GroupTemplate {
  return {
    pk: num(row.id),
    name: str(row.name),
    groupName: str(row.group_name),
    members: decodeMemberIds(str(row.members)),
    description: str(row.description),
    createdAt: str(row.created_at),
    updatedAt: str(row.updated_at),
  }
}

function jobFromRow(row: DbRow): GroupJob {
  return {
    pk: num(row.id),
    templatePk: row.template_pk === null || row.template_pk === undefined ? null : num(row.template_pk),
    templateName: str(row.template_name),
    groupName: str(row.group_name),
    members: decodeMemberIds(str(row.members)),
    status: str(row.status) as GroupJobStatus,
    groupId: str(row.group_id),
    error: str(row.error),
    createdAt: str(row.created_at),
    finishedAt: nullable(row.finished_at),
  }
}

// ---------------------------------------------------------------- WHERE 构造

/** 组合 SELECT + WHERE + ORDER BY + LIMIT/OFFSET，返回 SQL 与参数（与 welink.ts 的 paged 同款） */
function paged(select: string, where: string, params: DbParam[], orderBy: string, limit: number, offset: number) {
  const sql = `${select} ${where} ${orderBy} LIMIT ?${params.length + 1} OFFSET ?${params.length + 2}`
  return { sql, params: [...params, limit, offset] }
}

/**
 * 历史 WHERE 构造（`listJobs` 与 `countJobs` **共用**，保证筛选口径不漂移）。
 * 返回的参数按 `?N` 顺序排列，供分页子句续接占位符。
 */
function buildJobWhere(query: Omit<GroupJobQuery, 'limit' | 'offset'>): { where: string; params: DbParam[] } {
  const clauses: string[] = []
  const params: DbParam[] = []
  const hold = (value: DbParam): number => {
    params.push(value)
    return params.length
  }

  if (query.status?.length) {
    const start = params.length + 1
    clauses.push(`status IN (${query.status.map((_, index) => `?${start + index}`).join(', ')})`)
    params.push(...query.status)
  }
  const keyword = query.keyword?.trim()
  if (keyword) {
    // 同一占位符复用三次：群名称 / 模板名 / 成员串用同一个 LIKE 值
    const index = hold(`%${keyword}%`)
    clauses.push(`(group_name LIKE ?${index} OR template_name LIKE ?${index} OR members LIKE ?${index})`)
  }
  if (query.from) clauses.push(`created_at >= ?${hold(query.from)}`)
  if (query.to) clauses.push(`created_at <= ?${hold(query.to)}`)

  return { where: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', params }
}

const TEMPLATE_COLUMNS = `id, name, group_name, members, description, created_at, updated_at`
const JOB_COLUMNS = `id, template_pk, template_name, group_name, members, status, group_id, error, created_at, finished_at`

// ---------------------------------------------------------------- 仓储实现

export const sqlGroupRepository: GroupRepository = {
  // ---------------- 模板 ----------------

  async listTemplates(limit) {
    const rows = await bridge.dbSelect(
      `SELECT ${TEMPLATE_COLUMNS} FROM welink_group_templates ORDER BY updated_at DESC, id DESC LIMIT ?1`,
      [limit],
    )
    return rows.map(templateFromRow)
  },

  async countTemplates() {
    const rows = await bridge.dbSelect('SELECT COUNT(*) AS count FROM welink_group_templates')
    return num(rows[0]?.count)
  },

  async getTemplate(pk) {
    const rows = await bridge.dbSelect(`SELECT ${TEMPLATE_COLUMNS} FROM welink_group_templates WHERE id = ?1`, [pk])
    return rows[0] ? templateFromRow(rows[0]) : null
  },

  async createTemplate(draft: GroupTemplateDraft) {
    const now = nowStamp()
    const result = await bridge.dbExecute(
      `INSERT INTO welink_group_templates(name, group_name, members, description, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
      [draft.name, draft.groupName, encodeMemberIds(draft.members), draft.description ?? '', now, now],
    )
    const saved = await sqlGroupRepository.getTemplate(result.lastInsertId)
    if (!saved) throw new Error(`模板写入后仍读取不到：#${result.lastInsertId}`)
    return saved
  },

  async updateTemplate(pk, draft: GroupTemplateDraft) {
    const result = await bridge.dbExecute(
      `UPDATE welink_group_templates
          SET name = ?2, group_name = ?3, members = ?4, description = ?5, updated_at = ?6
        WHERE id = ?1`,
      [pk, draft.name, draft.groupName, encodeMemberIds(draft.members), draft.description ?? '', nowStamp()],
    )
    return result.changes > 0
  },

  async removeTemplate(pk) {
    const result = await bridge.dbExecute('DELETE FROM welink_group_templates WHERE id = ?1', [pk])
    return result.changes > 0
  },

  // ---------------- 建群历史 ----------------

  async createJob(draft: GroupJobDraft) {
    const now = nowStamp()
    const result = await bridge.dbExecute(
      `INSERT INTO welink_group_jobs(template_pk, template_name, group_name, members, status, created_at)
       VALUES (?1, ?2, ?3, ?4, 'pending', ?5)`,
      [draft.templatePk, draft.templateName, draft.groupName, encodeMemberIds(draft.members), now],
    )
    const rows = await bridge.dbSelect(`SELECT ${JOB_COLUMNS} FROM welink_group_jobs WHERE id = ?1`, [
      result.lastInsertId,
    ])
    if (!rows[0]) throw new Error(`建群留痕写入后仍读取不到：#${result.lastInsertId}`)
    return jobFromRow(rows[0])
  },

  async completeJob(pk, groupId) {
    // 原子终态：只允许从 pending 落到 success —— 启动清扫已把它标成 interrupted 时，
    // 本次外呼回写不得覆盖（结果未知比谎报成功诚实）。
    const result = await bridge.dbExecute(
      `UPDATE welink_group_jobs SET status = 'success', group_id = ?2, error = '', finished_at = ?3
        WHERE id = ?1 AND status = 'pending'`,
      [pk, groupId, nowStamp()],
    )
    return result.changes > 0
  },

  async failJob(pk, error) {
    const result = await bridge.dbExecute(
      `UPDATE welink_group_jobs SET status = 'failed', error = ?2, finished_at = ?3
        WHERE id = ?1 AND status = 'pending'`,
      [pk, error, nowStamp()],
    )
    return result.changes > 0
  },

  async markInterrupted() {
    const result = await bridge.dbExecute(
      `UPDATE welink_group_jobs
          SET status = 'interrupted', error = '应用中断，创建结果未知', finished_at = ?1
        WHERE status = 'pending'`,
      [nowStamp()],
    )
    return result.changes
  },

  async listJobs(query: GroupJobQuery) {
    const { where, params } = buildJobWhere(query)
    const { sql, params: all } = paged(
      `SELECT ${JOB_COLUMNS} FROM welink_group_jobs`,
      where,
      params,
      'ORDER BY created_at DESC, id DESC',
      query.limit,
      query.offset,
    )
    const rows = await bridge.dbSelect(sql, all)
    return rows.map(jobFromRow)
  },

  async countJobs(query: Omit<GroupJobQuery, 'limit' | 'offset'>) {
    const { where, params } = buildJobWhere(query)
    const rows = await bridge.dbSelect(`SELECT COUNT(*) AS count FROM welink_group_jobs ${where}`, params)
    return num(rows[0]?.count)
  },

  async removeJob(pk) {
    const result = await bridge.dbExecute('DELETE FROM welink_group_jobs WHERE id = ?1', [pk])
    return result.changes > 0
  },
}
