import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 快速建群两表仓储单测（migration v3，与 `welink.spec.ts` 同构）。
 *
 * Q1 决策把 SQL 全放在 TS，业务正确性就写在 SQL 里，必须用文本断言钉住：
 *  1. **分页强制**（P7）—— 列表 SQL 必含 LIMIT，且 limit/offset 是参数；
 *  2. **先留痕后外呼** —— completeJob/failJob 都带 `AND status='pending'` 原子守卫；
 *  3. **列表与计数同口径** —— listJobs 与 countJobs 共用同一个 WHERE 构造器；
 *  4. 内存实现与 SQL 实现**契约一致**（同一组断言跑两遍的关键语义各测一遍）。
 */

import type { DbParam, DbRow, ExecResult } from '@/types'
import type { GroupJobDraft, GroupTemplateDraft } from '@/types/welink'

type SelectFn = (sql: string, params?: DbParam[]) => Promise<DbRow[]>

const db = vi.hoisted(() => ({
  dbExecute: vi.fn<(sql: string, params: DbParam[]) => Promise<ExecResult>>(async () => ({
    changes: 1,
    lastInsertId: 7,
  })),
  dbSelect: vi.fn<SelectFn>(async () => []),
}))

vi.mock('@/api', () => ({
  bridge: db,
  platform: 'tauri',
}))

import { migrationV3 } from '@/infra/db/migrations/group'
import { sqlGroupRepository as sqlRepo } from '@/infra/db/repos/welink-group'
import { memoryGroupRepository as memRepo, resetGroupMemory } from '@/infra/db/repos/welink-group-memory'

function resetDb() {
  db.dbExecute.mockReset()
  db.dbSelect.mockReset()
  db.dbExecute.mockResolvedValue({ changes: 1, lastInsertId: 7 })
  db.dbSelect.mockResolvedValue([])
}

beforeEach(() => {
  resetDb()
  resetGroupMemory()
})

function lastExec() {
  const call = db.dbExecute.mock.calls.at(-1)!
  return { sql: call[0], params: call[1] ?? [] }
}

function lastSelect() {
  const call = db.dbSelect.mock.calls.at(-1)!
  return { sql: call[0], params: call[1] ?? [] }
}

const templateDraft: GroupTemplateDraft = {
  name: '项目周会群',
  groupName: '项目周会群',
  members: ['E-0001', 'E-0002'],
  description: '每周一同步',
}

const jobDraft: GroupJobDraft = {
  templatePk: 3,
  templateName: '项目周会群',
  groupName: '项目周会群',
  members: ['E-0001', 'E-0002'],
}

describe('infra/db/group —— 迁移 v3', () => {
  it('版本号与描述固定（迁移表按 version 去重，改错会重复执行）', () => {
    expect(migrationV3.version).toBe(3)
    expect(migrationV3.description).toBe('create_group_builder')
  })

  it('两张表齐备', () => {
    expect(migrationV3.sql).toContain('CREATE TABLE welink_group_templates')
    expect(migrationV3.sql).toContain('CREATE TABLE welink_group_jobs')
  })

  it('status 的 CHECK 枚举与 TS 的 GroupJobStatus 完全一致', () => {
    expect(migrationV3.sql).toContain("CHECK (status IN ('pending','success','failed','interrupted'))")
  })

  it('template_pk 置空引用：模板删除后历史快照仍在（SET NULL，不级联删历史）', () => {
    expect(migrationV3.sql).toMatch(/template_pk\s+INTEGER REFERENCES welink_group_templates\(id\) ON DELETE SET NULL/)
  })

  it('注册进全库迁移注册表（唯一真值）', async () => {
    const { MIGRATIONS } = await import('@/infra/db')
    expect(MIGRATIONS.map((item) => item.version)).toEqual([1, 2, 3])
  })
})

describe('infra/db/group —— SQL 仓储', () => {
  it('listTemplates 带 LIMIT（P7），按更新时间倒序', async () => {
    await sqlRepo.listTemplates(50)
    const { sql, params } = lastSelect()
    expect(sql).toContain('ORDER BY updated_at DESC, id DESC')
    expect(sql).toMatch(/LIMIT \?1$/)
    expect(params).toEqual([50])
  })

  it('createTemplate 绑定成员逗号串并回读', async () => {
    db.dbSelect.mockResolvedValueOnce([
      {
        id: 7,
        name: '项目周会群',
        group_name: '项目周会群',
        members: 'E-0001,E-0002',
        description: '每周一同步',
        created_at: '2026-09-30 10:00:00',
        updated_at: '2026-09-30 10:00:00',
      },
    ])
    const saved = await sqlRepo.createTemplate(templateDraft)
    const { sql, params } = lastExec()
    expect(sql).toContain('INSERT INTO welink_group_templates')
    expect(params).toEqual([
      '项目周会群',
      '项目周会群',
      'E-0001,E-0002',
      '每周一同步',
      expect.any(String),
      expect.any(String),
    ])
    expect(saved.pk).toBe(7)
    expect(saved.members).toEqual(['E-0001', 'E-0002'])
  })

  it('updateTemplate 以 changes>0 报告是否命中', async () => {
    expect(await sqlRepo.updateTemplate(7, templateDraft)).toBe(true)
    expect(lastExec().sql).toContain('UPDATE welink_group_templates')

    db.dbExecute.mockResolvedValueOnce({ changes: 0, lastInsertId: 0 })
    expect(await sqlRepo.updateTemplate(7, templateDraft)).toBe(false)
  })

  it('createJob 只以 pending 落库（先留痕铁律在 SQL 层的形态）', async () => {
    db.dbSelect.mockResolvedValueOnce([
      {
        id: 7,
        template_pk: 3,
        template_name: '项目周会群',
        group_name: '项目周会群',
        members: 'E-0001,E-0002',
        status: 'pending',
        group_id: '',
        error: '',
        created_at: '2026-09-30 10:00:00',
        finished_at: null,
      },
    ])
    const job = await sqlRepo.createJob(jobDraft)
    const { sql, params } = lastExec()
    expect(sql).toContain("'pending'")
    expect(params).toEqual([3, '项目周会群', '项目周会群', 'E-0001,E-0002', expect.any(String)])
    expect(job.status).toBe('pending')
    expect(job.members).toEqual(['E-0001', 'E-0002'])
  })

  it('completeJob 带 status=pending 原子守卫（终态不得被并发覆盖）', async () => {
    const done = await sqlRepo.completeJob(7, 'G-777')
    expect(done).toBe(true)
    const { sql } = lastExec()
    expect(sql).toContain("SET status = 'success', group_id = ?2")
    expect(sql).toContain("WHERE id = ?1 AND status = 'pending'")

    db.dbExecute.mockResolvedValueOnce({ changes: 0, lastInsertId: 0 })
    expect(await sqlRepo.completeJob(7, 'G-777')).toBe(false)
  })

  it('failJob 带同样的 pending 守卫并写入错误全文', async () => {
    await sqlRepo.failJob(7, '成员不存在：E-9999')
    const { sql, params } = lastExec()
    expect(sql).toContain("SET status = 'failed', error = ?2")
    expect(sql).toContain("WHERE id = ?1 AND status = 'pending'")
    expect(params[1]).toBe('成员不存在：E-9999')
  })

  it('markInterrupted 只翻 pending（运行中的其它终态不动）', async () => {
    db.dbExecute.mockResolvedValueOnce({ changes: 2, lastInsertId: 0 })
    expect(await sqlRepo.markInterrupted()).toBe(2)
    expect(lastExec().sql).toContain("WHERE status = 'pending'")
  })

  it('listJobs：status IN + 关键词 LIKE + 时间段全部参数化，LIMIT 收尾', async () => {
    await sqlRepo.listJobs({
      status: ['failed', 'interrupted'],
      keyword: '周会',
      from: '2026-09-01 00:00:00',
      to: '2026-09-30 23:59:59',
      limit: 10,
      offset: 20,
    })
    const { sql, params } = lastSelect()
    expect(sql).toContain('status IN (?1, ?2)')
    expect(sql).toContain(
      "(group_name LIKE ?3 ESCAPE '\\' OR template_name LIKE ?3 ESCAPE '\\' OR members LIKE ?3 ESCAPE '\\')",
    )
    expect(sql).toContain('created_at >= ?4')
    expect(sql).toContain('created_at <= ?5')
    // ORDER BY 必须在 LIMIT 之前；LIMIT/OFFSET 是尾随参数（P7）
    expect(sql).toMatch(/ORDER BY created_at DESC, id DESC LIMIT \?6 OFFSET \?7$/)
    expect(params).toEqual(['failed', 'interrupted', '%周会%', '2026-09-01 00:00:00', '2026-09-30 23:59:59', 10, 20])
  })

  it('listJobs 关键词里的 %/_ 按字面量转义（搜「100%」不全表通配）', async () => {
    await sqlRepo.listJobs({ keyword: '100%', limit: 10, offset: 0 })
    const { sql, params } = lastSelect()
    expect(sql).toContain("ESCAPE '\\'")
    expect(params[0]).toBe('%100\\%%')
  })

  it('countJobs 与 listJobs 同口径（分页脚数字必须对得上）', async () => {
    db.dbSelect.mockResolvedValueOnce([{ count: 5 }])
    const count = await sqlRepo.countJobs({ status: ['failed'], keyword: '周会' })
    expect(count).toBe(5)
    const { sql, params } = lastSelect()
    expect(sql).toContain('COUNT(*)')
    expect(sql).toContain('status IN (?1)')
    expect(sql).toContain('LIKE ?2')
    expect(sql).not.toContain('LIMIT')
    expect(params).toEqual(['failed', '%周会%'])
  })

  it('removeJob 按 id 删除且返回是否命中', async () => {
    expect(await sqlRepo.removeJob(7)).toBe(true)
    expect(lastExec().sql).toBe('DELETE FROM welink_group_jobs WHERE id = ?1')

    db.dbExecute.mockResolvedValueOnce({ changes: 0, lastInsertId: 0 })
    expect(await sqlRepo.removeJob(7)).toBe(false)
  })
})

describe('infra/db/group —— 内存仓储契约（与 SQL 实现一致）', () => {
  it('模板 CRUD 往返，列表按更新时间倒序', async () => {
    const created = await memRepo.createTemplate(templateDraft)
    expect(created.pk).toBeGreaterThan(0)
    expect(created.members).toEqual(['E-0001', 'E-0002'])

    const updated = await memRepo.updateTemplate(created.pk, { ...templateDraft, name: '改名' })
    expect(updated).toBe(true)
    const list = await memRepo.listTemplates(10)
    expect(list[0]?.name).toBe('改名')

    expect(await memRepo.removeTemplate(created.pk)).toBe(true)
    expect(await memRepo.getTemplate(created.pk)).toBeNull()
  })

  it('建群留痕 → 成功终态；二次终态写不进去（pending 守卫）', async () => {
    const job = await memRepo.createJob(jobDraft)
    expect(job.status).toBe('pending')

    expect(await memRepo.completeJob(job.pk, 'G-1')).toBe(true)
    expect(await memRepo.completeJob(job.pk, 'G-2')).toBe(false)
    const saved = await memRepo.listJobs({ limit: 10, offset: 0 })
    expect(saved[0]).toMatchObject({ status: 'success', groupId: 'G-1' })
  })

  it('失败终态携带错误全文；成功后不能再改失败', async () => {
    const job = await memRepo.createJob(jobDraft)
    expect(await memRepo.failJob(job.pk, '成员不存在')).toBe(true)
    expect(await memRepo.failJob(job.pk, '再来一次')).toBe(false)
    const [saved] = await memRepo.listJobs({ limit: 10, offset: 0 })
    expect(saved?.error).toBe('成员不存在')
  })

  it('markInterrupted 只翻 pending 并返回条数', async () => {
    const a = await memRepo.createJob(jobDraft)
    const b = await memRepo.createJob(jobDraft)
    const c = await memRepo.createJob(jobDraft)
    await memRepo.completeJob(a.pk, 'G-1')
    expect(await memRepo.markInterrupted()).toBe(2)
    const rows = await memRepo.listJobs({ limit: 10, offset: 0 })
    const statusOf = (pk: number) => rows.find((item) => item.pk === pk)?.status
    expect(statusOf(a.pk)).toBe('success')
    expect(statusOf(b.pk)).toBe('interrupted')
    expect(statusOf(c.pk)).toBe('interrupted')
    expect(await memRepo.markInterrupted()).toBe(0)
  })

  it('listJobs 筛选（状态/关键词/时间段）与 SQL 版同口径', async () => {
    const a = await memRepo.createJob({ ...jobDraft, groupName: '项目周会群' })
    await memRepo.createJob({ ...jobDraft, templatePk: null, templateName: '', groupName: '临时群' })
    await memRepo.failJob(a.pk, 'boom')

    const failedOnly = await memRepo.listJobs({ status: ['failed'], limit: 10, offset: 0 })
    expect(failedOnly).toHaveLength(1)
    expect(failedOnly[0]?.groupName).toBe('项目周会群')

    const byKeyword = await memRepo.listJobs({ keyword: '临时', limit: 10, offset: 0 })
    expect(byKeyword).toHaveLength(1)
    expect(byKeyword[0]?.groupName).toBe('临时群')

    const all = await memRepo.listJobs({ limit: 10, offset: 0 })
    expect(all).toHaveLength(2)
    const paged = await memRepo.listJobs({ limit: 1, offset: 1 })
    expect(paged).toHaveLength(1)

    expect(await memRepo.countJobs({ status: ['failed'] })).toBe(1)
  })

  it('模板删除后历史快照不受影响（template 字段是快照列）', async () => {
    const template = await memRepo.createTemplate(templateDraft)
    const job = await memRepo.createJob({
      templatePk: template.pk,
      templateName: template.name,
      groupName: template.groupName,
      members: template.members,
    })
    await memRepo.removeTemplate(template.pk)
    const [saved] = await memRepo.listJobs({ limit: 10, offset: 0 })
    expect(saved?.pk).toBe(job.pk)
    expect(saved?.templateName).toBe('项目周会群')
    expect(saved?.members).toEqual(['E-0001', 'E-0002'])
  })
})
