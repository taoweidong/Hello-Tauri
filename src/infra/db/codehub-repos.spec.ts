import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * CodeHub 检视域三表仓储单测（migration v4，与 `group-repos.spec.ts` 同构）。
 *
 * Q1 决策把 SQL 全放在 TS，业务正确性就写在 SQL 里，必须用文本断言钉住：
 *  1. **分页强制**（P7）—— 列表 SQL 必含 LIMIT，且 limit/offset 是参数；
 *  2. **快照覆盖写** —— applySnapshot 用 ON CONFLICT(repo_id, mr_iid) upsert，
 *     整批与同步状态 success 落在同一事务；markSyncError 只动 last_error；
 *  3. **列表与计数同口径** —— listMrs 与 countMrs 共用同一个 WHERE 构造器；
 *  4. 内存实现与 SQL 实现**契约一致**（关键语义各测一遍）。
 */

import type { DbParam, DbRow, ExecResult } from '@/types'
import type { CodeHubMrRecord } from '@/types/codehub'

type SelectFn = (sql: string, params?: DbParam[]) => Promise<DbRow[]>

const db = vi.hoisted(() => ({
  dbExecute: vi.fn<(sql: string, params: DbParam[]) => Promise<ExecResult>>(async () => ({
    changes: 1,
    lastInsertId: 7,
  })),
  dbSelect: vi.fn<SelectFn>(async () => []),
  dbTransaction: vi.fn<(statements: { sql: string; params?: DbParam[] }[]) => Promise<number[]>>(async () => []),
}))

const platformState = vi.hoisted(() => ({ platform: 'tauri' as 'tauri' | 'web' }))

vi.mock('@/api', () => ({
  bridge: db,
  get platform() {
    return platformState.platform
  },
}))

import { MIGRATIONS } from '@/infra/db/index'
import { migrationV4 } from '@/infra/db/migrations/codehub'
import { sqlCodehubRepository as sqlRepo } from '@/infra/db/repos/codehub'
import { memoryCodehubRepository as memRepo, resetCodehubMemory } from '@/infra/db/repos/codehub-memory'

function resetDb() {
  db.dbExecute.mockReset()
  db.dbSelect.mockReset()
  db.dbTransaction.mockReset()
  db.dbExecute.mockResolvedValue({ changes: 1, lastInsertId: 7 })
  db.dbSelect.mockResolvedValue([])
  db.dbTransaction.mockResolvedValue([])
}

beforeEach(() => {
  resetDb()
  resetCodehubMemory()
})

function lastExec() {
  const call = db.dbExecute.mock.calls.at(-1)!
  return { sql: call[0], params: call[1] ?? [] }
}

const DETAIL = {
  description: '详情描述',
  comments: [{ author: 'bob', body: '意见', createdAt: '2026-10-02T10:30:00+08:00' }],
}

function mrRecord(
  overrides: Partial<CodeHubMrRecord['summary']> = {},
  detail: CodeHubMrRecord['detail'] = null,
): CodeHubMrRecord {
  return {
    summary: {
      repoId: 'demo/x',
      mrIid: '101',
      title: 'T1',
      state: 'open',
      author: 'alice',
      sourceBranch: 'feat/x',
      targetBranch: 'main',
      updatedAt: '2026-10-02T10:00:00+08:00',
      webUrl: '',
      review: { reviewers: ['bob'], approvals: 1, unresolved: 0, lastActivityAt: '' },
      ...overrides,
    },
    detail,
  }
}

function mrRow(overrides: Partial<Record<string, DbParam>> = {}): DbRow {
  return {
    repo_id: 'demo/x',
    mr_iid: '101',
    title: 'T1',
    state: 'open',
    author: 'alice',
    source_branch: 'feat/x',
    target_branch: 'main',
    updated_at: '2026-10-02T10:00:00+08:00',
    web_url: '',
    reviewers: '["bob"]',
    approvals: 1,
    unresolved: 0,
    last_activity_at: '',
    detail_json: null,
    synced_at: '',
    ...overrides,
  }
}

describe('infra/db/codehub —— 迁移 v4', () => {
  it('版本号与描述固定（迁移表按 version 去重，改错会重复执行）', () => {
    expect(migrationV4.version).toBe(4)
    expect(migrationV4.description).toBe('create_codehub_review')
  })

  it('三张表齐备，且注册进全库迁移注册表（唯一真值）', () => {
    expect(migrationV4.sql).toContain('CREATE TABLE codehub_repos')
    expect(migrationV4.sql).toContain('CREATE TABLE codehub_mrs')
    expect(migrationV4.sql).toContain('CREATE TABLE codehub_sync_state')
    expect(MIGRATIONS.map((migration) => migration.version)).toEqual([1, 2, 3, 4, 5, 6])
  })

  it('state 的 CHECK 枚举与 TS 的 CodeHubMrState 完全一致', () => {
    expect(migrationV4.sql).toContain("CHECK (state IN ('open','merged','closed'))")
  })

  it('MR 快照以 (repo_id, mr_iid) 为主键（覆盖写的前提），仓库 repo_id 唯一', () => {
    expect(migrationV4.sql).toMatch(/PRIMARY KEY \(repo_id, mr_iid\)/)
    expect(migrationV4.sql).toMatch(/repo_id\s+TEXT NOT NULL UNIQUE/)
  })
})

describe('infra/db —— codehub 仓储单例（平台选择）', () => {
  it('桌面 = SQL 实现；浏览器 = 内存实现；setCodehubRepository(null) 复位后按当前平台重选', async () => {
    vi.resetModules()
    // resetModules 后模块图重建，必须与「新鲜实例」对比（静态导入的是旧实例）
    const dbi = await import('@/infra/db/index')
    const freshSql = (await import('@/infra/db/repos/codehub')).sqlCodehubRepository
    const freshMem = (await import('@/infra/db/repos/codehub-memory')).memoryCodehubRepository
    expect(dbi.codehub()).toBe(freshSql) // tauri → SQL
    expect(dbi.codehub()).toBe(freshSql) // 单例缓存
    dbi.setCodehubRepository(null)
    platformState.platform = 'web'
    expect(dbi.codehub()).toBe(freshMem) // web → 内存
    dbi.setCodehubRepository(null)
    platformState.platform = 'tauri'
  })
})

describe('infra/db/codehub —— applySnapshot（快照覆盖写）', () => {
  it('整批 upsert + 同步状态 success 落在同一事务，返回写入条数', async () => {
    const records = [mrRecord({ mrIid: '101' }), mrRecord({ mrIid: '102', state: 'merged' })]
    const written = await sqlRepo.applySnapshot('demo/x', records, '2026-10-03T08:00:00+08:00')
    expect(written).toBe(2)
    expect(db.dbTransaction).toHaveBeenCalledTimes(1)
    const statements = db.dbTransaction.mock.calls[0]![0]
    expect(statements).toHaveLength(3) // 2 条 upsert + 1 条同步状态
    expect(statements[0]!.sql).toContain('ON CONFLICT(repo_id, mr_iid) DO UPDATE')
    expect(statements[2]!.sql).toContain('codehub_sync_state')
    expect(statements[2]!.sql).toContain('last_error = NULL')
  })

  it('detail 为 null 时详情列绑 null；reviewers 以 JSON 串绑定', async () => {
    await sqlRepo.applySnapshot(
      'demo/x',
      [mrRecord({}, DETAIL), mrRecord({ mrIid: '102' }, null)],
      '2026-10-03T08:00:00+08:00',
    )
    const statements = db.dbTransaction.mock.calls[0]![0]
    // 事务语句的 params 在类型上是可选的：这里收口成「必存在，否则测试直接失败」，
    // 既满足严格类型，也不让漏绑参退化成 undefined 通过断言
    const bound = (index: number, slot: number): DbParam | undefined => {
      const params = statements[index]?.params
      if (!params) throw new Error(`第 ${index} 条语句缺少 params 绑定`)
      return params[slot]
    }
    expect(bound(0, 13)).toBe(JSON.stringify(DETAIL))
    expect(bound(1, 13)).toBeNull()
    expect(bound(0, 9)).toBe('["bob"]')
  })

  it('空批次 = 仅刷新同步状态（1 条语句），合法', async () => {
    const written = await sqlRepo.applySnapshot('demo/x', [], '2026-10-03T08:00:00+08:00')
    expect(written).toBe(0)
    expect(db.dbTransaction.mock.calls[0]![0]).toHaveLength(1)
  })
})

describe('infra/db/codehub —— listMrs / countMrs（分页强制 + 同口径）', () => {
  it('列表 SQL 必含 LIMIT/OFFSET 且为参数；状态筛选进 WHERE', async () => {
    db.dbSelect.mockResolvedValue([mrRow()])
    const items = await sqlRepo.listMrs({ state: 'open', limit: 20, offset: 40 })
    expect(items).toHaveLength(1)
    expect(items[0]!.summary.mrIid).toBe('101')
    const call = db.dbSelect.mock.calls[0]!
    expect(call[0]).toContain('WHERE state = ?1')
    expect(call[0]).toContain('LIMIT ?2 OFFSET ?3')
    expect(call[0]).not.toContain('*') // 防止 SELECT *
    expect(call[1]).toEqual(['open', 20, 40])
  })

  it('仓库 + 状态组合筛选；行映射还原 reviewers 与 detail_json', async () => {
    db.dbSelect.mockResolvedValue([mrRow({ detail_json: JSON.stringify(DETAIL), reviewers: '["bob","carol"]' })])
    const items = await sqlRepo.listMrs({ repoId: 'demo/x', state: 'merged', limit: 10, offset: 0 })
    expect(items[0]!.summary.review.reviewers).toEqual(['bob', 'carol'])
    expect(items[0]!.detail).toEqual(DETAIL)
    const call = db.dbSelect.mock.calls[0]!
    expect(call[0]).toContain('WHERE repo_id = ?1 AND state = ?2')
    expect(call[1]).toEqual(['demo/x', 'merged', 10, 0])
  })

  it('detail_json 损坏或 reviewers 损坏 → 降级为空值，不让列表崩', async () => {
    db.dbSelect.mockResolvedValue([mrRow({ detail_json: '{broken', reviewers: 'not-json' })])
    const items = await sqlRepo.listMrs({ limit: 10, offset: 0 })
    expect(items[0]!.detail).toBeNull()
    expect(items[0]!.summary.review.reviewers).toEqual([])
  })

  it('countMrs 与 listMrs 同口径（同 WHERE、无 LIMIT）', async () => {
    db.dbSelect.mockResolvedValue([{ count: 5 }])
    const count = await sqlRepo.countMrs({ state: 'open' })
    expect(count).toBe(5)
    const call = db.dbSelect.mock.calls[0]!
    expect(call[0]).toContain('WHERE state = ?1')
    expect(call[0]).not.toContain('LIMIT')
    expect(call[1]).toEqual(['open'])
  })

  it('getMr 按仓库 + iid 精确查询', async () => {
    db.dbSelect.mockResolvedValue([mrRow()])
    await sqlRepo.getMr('demo/x', '101')
    expect(db.dbSelect.mock.calls[0]![0]).toContain('WHERE repo_id = ?1 AND mr_iid = ?2')
  })
})

describe('infra/db/codehub —— 仓库注册', () => {
  it('addRepo 幂等：ON CONFLICT(repo_id) 更新名称，写后回读', async () => {
    db.dbSelect.mockResolvedValue([mrRow({ id: 3, repo_id: 'demo/x', name: '示例' })].map((row) => ({ id: 3, ...row })))
    const repo = await sqlRepo.addRepo('demo/x', '示例')
    expect(repo.pk).toBe(3)
    expect(repo.repoId).toBe('demo/x')
    expect(db.dbExecute.mock.calls[0]![0]).toContain('ON CONFLICT(repo_id) DO UPDATE SET name = excluded.name')
  })

  it('removeRepo 显式级联：同事务删快照、同步状态与注册行', async () => {
    db.dbSelect.mockResolvedValue([{ repo_id: 'demo/x' }])
    const removed = await sqlRepo.removeRepo(3)
    expect(removed).toBe(true)
    const statements = db.dbTransaction.mock.calls[0]![0]
    expect(statements.map((statement) => statement.sql)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('DELETE FROM codehub_mrs WHERE repo_id'),
        expect.stringContaining('DELETE FROM codehub_sync_state WHERE repo_id'),
        expect.stringContaining('DELETE FROM codehub_repos WHERE id'),
      ]),
    )
  })

  it('removeRepo 目标不存在：不启动事务', async () => {
    db.dbSelect.mockResolvedValue([])
    await expect(sqlRepo.removeRepo(99)).resolves.toBe(false)
    expect(db.dbTransaction).not.toHaveBeenCalled()
  })

  it('setRepoEnabled 写入 0/1 而非布尔', async () => {
    await sqlRepo.setRepoEnabled(3, false)
    const { params } = lastExec()
    expect(params).toEqual([3, 0])
  })
})

describe('infra/db/codehub —— 同步状态与详情补写', () => {
  it('markSyncError 只更新 last_error，保留既有 last_synced_at', async () => {
    await sqlRepo.markSyncError('demo/x', '命令超时')
    const { sql, params } = lastExec()
    expect(sql).toContain('ON CONFLICT(repo_id) DO UPDATE SET last_error = excluded.last_error')
    expect(sql).not.toContain('last_synced_at = excluded')
    expect(params).toEqual(['demo/x', '命令超时'])
  })

  it('saveMrDetail 只更新详情列与 synced_at', async () => {
    const saved = await sqlRepo.saveMrDetail('demo/x', '101', DETAIL, '2026-10-03T09:00:00+08:00')
    expect(saved).toBe(true)
    const { sql, params } = lastExec()
    expect(sql).toContain('SET detail_json = ?3, synced_at = ?4 WHERE repo_id = ?1 AND mr_iid = ?2')
    expect(params[2]).toBe(JSON.stringify(DETAIL))
  })

  it('listSyncStates 的 NULL 列归一为 null（从未同步的仓库语义）', async () => {
    db.dbSelect.mockResolvedValue([{ repo_id: 'demo/x', last_synced_at: null, last_error: 'boom' }])
    const states = await sqlRepo.listSyncStates()
    expect(states[0]).toEqual({ repoId: 'demo/x', lastSyncedAt: null, lastError: 'boom' })
  })
})

describe('infra/db/codehub —— 内存实现契约一致', () => {
  it('applySnapshot 覆盖写幂等：同 iid 只留一行、字段以最新为准', async () => {
    await memRepo.applySnapshot('demo/x', [mrRecord({ title: '旧标题' })], '2026-10-02T08:00:00+08:00')
    await memRepo.applySnapshot('demo/x', [mrRecord({ title: '新标题' }, DETAIL)], '2026-10-03T08:00:00+08:00')
    expect(await memRepo.countMrs({})).toBe(1)
    const items = await memRepo.listMrs({ limit: 10, offset: 0 })
    expect(items[0]!.summary.title).toBe('新标题')
    expect(items[0]!.detail).toEqual(DETAIL)
    const states = await memRepo.listSyncStates()
    expect(states[0]!.lastSyncedAt).toBe('2026-10-03T08:00:00+08:00')
    expect(states[0]!.lastError).toBeNull()
  })

  it('筛选与分页：仓库/状态过滤 + limit/offset + updated_at 倒序', async () => {
    await memRepo.applySnapshot(
      'demo/x',
      [
        mrRecord({ mrIid: '101', updatedAt: '2026-10-01T00:00:00+08:00' }),
        mrRecord({ mrIid: '102', updatedAt: '2026-10-03T00:00:00+08:00', state: 'merged' }),
        mrRecord({ mrIid: '201', repoId: 'demo/y' }),
      ],
      '2026-10-03T08:00:00+08:00',
    )
    expect(await memRepo.countMrs({ repoId: 'demo/x' })).toBe(2)
    const merged = await memRepo.listMrs({ repoId: 'demo/x', state: 'merged', limit: 10, offset: 0 })
    expect(merged.map((record) => record.summary.mrIid)).toEqual(['102'])
    const paged = await memRepo.listMrs({ limit: 1, offset: 1 })
    expect(paged).toHaveLength(1)
    expect(paged[0]!.summary.updatedAt).toBe('2026-10-02T10:00:00+08:00') // 第二新的在前页之后
  })

  it('markSyncError 保留 last_synced_at（旧快照仍可读的语义前提）', async () => {
    await memRepo.applySnapshot('demo/x', [mrRecord()], '2026-10-03T08:00:00+08:00')
    await memRepo.markSyncError('demo/x', '命令超时')
    const states = await memRepo.listSyncStates()
    expect(states[0]).toEqual({ repoId: 'demo/x', lastSyncedAt: '2026-10-03T08:00:00+08:00', lastError: '命令超时' })
  })

  it('removeRepo 级联删快照与同步状态；addRepo 幂等', async () => {
    const repo = await memRepo.addRepo('demo/x', '示例')
    await memRepo.applySnapshot('demo/x', [mrRecord()], '2026-10-03T08:00:00+08:00')
    const again = await memRepo.addRepo('demo/x', '改名')
    expect(again.pk).toBe(repo.pk)
    expect(again.name).toBe('改名')

    await expect(memRepo.removeRepo(repo.pk)).resolves.toBe(true)
    expect(await memRepo.listRepos(10)).toEqual([])
    expect(await memRepo.countMrs({ repoId: 'demo/x' })).toBe(0)
    expect(await memRepo.listSyncStates()).toEqual([])
    await expect(memRepo.removeRepo(999)).resolves.toBe(false)
  })

  it('saveMrDetail 只补详情不新建行；目标不存在返回 false', async () => {
    await memRepo.applySnapshot('demo/x', [mrRecord()], '2026-10-03T08:00:00+08:00')
    await expect(memRepo.saveMrDetail('demo/x', '101', DETAIL, '2026-10-03T09:00:00+08:00')).resolves.toBe(true)
    expect((await memRepo.getMr('demo/x', '101'))!.detail).toEqual(DETAIL)
    await expect(memRepo.saveMrDetail('demo/x', '404', DETAIL, '2026-10-03T09:00:00+08:00')).resolves.toBe(false)
    expect(await memRepo.countMrs({})).toBe(1)
  })

  it('getMr 精确查询：命中返回记录、未命中返回 null', async () => {
    await memRepo.applySnapshot('demo/x', [mrRecord()], '2026-10-03T08:00:00+08:00')
    expect((await memRepo.getMr('demo/x', '101'))!.summary.mrIid).toBe('101')
    expect(await memRepo.getMr('demo/x', '404')).toBeNull()
    expect(await memRepo.getMr('demo/y', '101')).toBeNull()
  })
})
