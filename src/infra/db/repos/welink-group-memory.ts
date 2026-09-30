/**
 * 快速建群仓储的内存实现（浏览器调试模式，Q3/D5：不做真 SQL）。
 *
 * 语义必须与 SQLite 实现**契约一致**（两套实现共享同一组测试断言）：
 *  * `completeJob` / `failJob` 的 `WHERE status='pending'` 原子守卫照实现；
 *  * `markInterrupted` 同事务语义（一次性把全部 pending 翻成 interrupted）；
 *  * 排序口径（created_at DESC, id DESC）与 SQL 版一致，避免 UI 抖动。
 */
import type { GroupJob, GroupJobDraft, GroupTemplate, GroupTemplateDraft } from '@/types/welink'
import { nowStamp } from '@/utils/time'
import type { GroupJobQuery, GroupRepository } from '../group-ports'

const STORAGE_KEY = 'hello-tauri:group'

interface MemoryState {
  seq: { template: number; job: number }
  templates: GroupTemplate[]
  jobs: GroupJob[]
}

function emptyState(): MemoryState {
  return { seq: { template: 0, job: 0 }, templates: [], jobs: [] }
}

function load(): MemoryState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return emptyState()
    const parsed = JSON.parse(raw) as MemoryState
    // 结构不完整时直接重建：调试模式的数据不值得为兼容老结构付出复杂度
    if (!parsed.seq || !Array.isArray(parsed.templates) || !Array.isArray(parsed.jobs)) return emptyState()
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
export function resetGroupMemory() {
  state = emptyState()
  flush()
}

/** 与 SQL 版 `ORDER BY created_at DESC, id DESC` 同口径 */
function descByCreated<T extends { pk: number; createdAt: string }>(items: T[]): T[] {
  return [...items].sort((a, b) => (a.createdAt === b.createdAt ? b.pk - a.pk : a.createdAt < b.createdAt ? 1 : -1))
}

/** 历史筛选（与 SQL 版 buildJobWhere 同口径的内存版） */
function matchJob(job: GroupJob, query: Omit<GroupJobQuery, 'limit' | 'offset'>): boolean {
  if (query.status?.length && !query.status.includes(job.status)) return false
  const keyword = query.keyword?.trim()
  if (keyword) {
    const haystack = `${job.groupName}\n${job.templateName}\n${job.members.join(',')}`
    if (!haystack.toLowerCase().includes(keyword.toLowerCase())) return false
  }
  if (query.from && job.createdAt < query.from) return false
  if (query.to && job.createdAt > query.to) return false
  return true
}

function cloneTemplate(template: GroupTemplate): GroupTemplate {
  return { ...template, members: [...template.members] }
}

function cloneJob(job: GroupJob): GroupJob {
  return { ...job, members: [...job.members] }
}

function draftOf(draft: GroupTemplateDraft) {
  return {
    name: draft.name,
    groupName: draft.groupName,
    members: [...draft.members],
    description: draft.description ?? '',
  }
}

export const memoryGroupRepository: GroupRepository = {
  // ---------------- 模板 ----------------

  async listTemplates(limit) {
    return [...state.templates]
      .sort((a, b) => (a.updatedAt === b.updatedAt ? b.pk - a.pk : a.updatedAt < b.updatedAt ? 1 : -1))
      .slice(0, limit)
      .map(cloneTemplate)
  },

  async countTemplates() {
    return state.templates.length
  },

  async getTemplate(pk) {
    const found = state.templates.find((item) => item.pk === pk)
    return found ? cloneTemplate(found) : null
  },

  async createTemplate(draft: GroupTemplateDraft) {
    state.seq.template += 1
    const now = nowStamp()
    const saved: GroupTemplate = { pk: state.seq.template, ...draftOf(draft), createdAt: now, updatedAt: now }
    state.templates.push(saved)
    flush()
    return cloneTemplate(saved)
  },

  async updateTemplate(pk, draft: GroupTemplateDraft) {
    const found = state.templates.find((item) => item.pk === pk)
    if (!found) return false
    Object.assign(found, draftOf(draft), { updatedAt: nowStamp() })
    flush()
    return true
  },

  async removeTemplate(pk) {
    const before = state.templates.length
    state.templates = state.templates.filter((item) => item.pk !== pk)
    const removed = state.templates.length < before
    if (removed) flush()
    return removed
  },

  // ---------------- 建群历史 ----------------

  async createJob(draft: GroupJobDraft) {
    state.seq.job += 1
    const job: GroupJob = {
      pk: state.seq.job,
      templatePk: draft.templatePk,
      templateName: draft.templateName,
      groupName: draft.groupName,
      members: [...draft.members],
      status: 'pending',
      groupId: '',
      error: '',
      createdAt: nowStamp(),
      finishedAt: null,
    }
    state.jobs.push(job)
    flush()
    return cloneJob(job)
  },

  async completeJob(pk, groupId) {
    const job = state.jobs.find((item) => item.pk === pk)
    if (!job || job.status !== 'pending') return false
    job.status = 'success'
    job.groupId = groupId
    job.error = ''
    job.finishedAt = nowStamp()
    flush()
    return true
  },

  async failJob(pk, error) {
    const job = state.jobs.find((item) => item.pk === pk)
    if (!job || job.status !== 'pending') return false
    job.status = 'failed'
    job.error = error
    job.finishedAt = nowStamp()
    flush()
    return true
  },

  async markInterrupted() {
    let count = 0
    for (const job of state.jobs) {
      if (job.status !== 'pending') continue
      job.status = 'interrupted'
      job.error = '应用中断，创建结果未知'
      job.finishedAt = nowStamp()
      count += 1
    }
    if (count) flush()
    return count
  },

  async listJobs(query: GroupJobQuery) {
    return descByCreated(state.jobs.filter((job) => matchJob(job, query)))
      .slice(query.offset, query.offset + query.limit)
      .map(cloneJob)
  },

  async countJobs(query: Omit<GroupJobQuery, 'limit' | 'offset'>) {
    return state.jobs.filter((job) => matchJob(job, query)).length
  },

  async removeJob(pk) {
    const before = state.jobs.length
    state.jobs = state.jobs.filter((item) => item.pk !== pk)
    const removed = state.jobs.length < before
    if (removed) flush()
    return removed
  },
}
