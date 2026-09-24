import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * SQL 仓储单测：断言生成的 SQL 与参数绑定序列 —— 这是 Q1 决策下真正的
 * 业务正确性所在（Rust 侧只是通用执行器）。同时验证迁移定义、种子导入、
 * 旧 table.json 升级路径、IN 列表参数化（防注入回归）。
 */

import type { DbParam, DbRow, ExecResult, Migration } from '@/types'

type SelectFn = (sql: string, params?: DbParam[]) => Promise<DbRow[]>
type TxnFn = (statements: { sql: string; params?: DbParam[] }[]) => Promise<number[]>

const db = vi.hoisted(() => ({
  platform: 'tauri',
  loadConfig: vi.fn(async () => null),
  saveConfig: vi.fn(async () => undefined),
  readTable: vi.fn<() => Promise<string | null>>(async () => null),
  writeTable: vi.fn<(content: string) => Promise<void>>(async () => undefined),
  appendLog: vi.fn(async () => 'memory://log'),
  storageInfo: vi.fn(async () => ({})),
  storageMigrate: vi.fn(async () => ({})),
  openStorageDir: vi.fn(async () => undefined),
  appInfo: vi.fn(async () => ({})),
  dbExecute: vi.fn<(sql: string, params: DbParam[]) => Promise<ExecResult>>(async () => ({
    changes: 1,
    lastInsertId: 42,
  })),
  dbSelect: vi.fn<SelectFn>(async () => [{ count: 0 }]),
  dbTransaction: vi.fn<TxnFn>(async () => []),
  dbMigrate: vi.fn<(migrations: Migration[]) => Promise<number[]>>(async () => [1]),
}))

vi.mock('@/api', () => ({
  bridge: db,
  get platform() {
    return db.platform
  },
}))

vi.mock('@/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

import { sqlRecordsBackend, SEED_ROWS } from '@/repositories/records'

function dbRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 7,
    name: 'x',
    category: '数据服务',
    status: 'active',
    amount: 100,
    owner: '张三',
    created_at: '2026-09-24',
    ...overrides,
  }
}

describe('sqlRecordsBackend', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    db.dbSelect.mockResolvedValue([{ count: 0 }])
    db.readTable.mockResolvedValue(null)
  })

  describe('prepare（迁移 + 空表种子导入）', () => {
    it('先跑版本化迁移', async () => {
      await sqlRecordsBackend.prepare()
      const migrations = db.dbMigrate.mock.calls[0][0]
      expect(migrations[0]).toMatchObject({ version: 1, description: 'create_records' })
      expect(migrations[0].sql).toContain('CREATE TABLE records')
    })

    it('表非空时不写种子', async () => {
      db.dbSelect.mockResolvedValue([{ count: 12 }])
      await sqlRecordsBackend.prepare()
      expect(db.dbTransaction).not.toHaveBeenCalled()
    })

    it('空表且无旧数据：插入 12 条内置种子（显式 ID，事务内）', async () => {
      await sqlRecordsBackend.prepare()
      expect(db.dbTransaction).toHaveBeenCalledTimes(1)
      const statements = db.dbTransaction.mock.calls[0][0]
      expect(statements).toHaveLength(12)
      expect(statements[0].sql).toContain('INSERT INTO records')
      expect(statements[0].params).toEqual([1, '日志采集网关', '基础设施', 'active', 12800, '张伟', '2026-01-08'])
    })

    it('空表但存在旧 table.json：导入旧数据而非种子（升级路径）', async () => {
      const legacy = [
        { id: 5, name: '旧记录A', category: '数据服务', status: 'inactive', amount: 1, owner: '甲', createdAt: '2026-01-01' },
        { id: 9, name: '旧记录B', category: '基础设施', status: 'active', amount: 2, owner: '乙', createdAt: '2026-02-01' },
      ]
      db.readTable.mockResolvedValue(JSON.stringify(legacy))
      await sqlRecordsBackend.prepare()
      const statements = db.dbTransaction.mock.calls[0][0]
      expect(statements).toHaveLength(2)
      expect(statements[1].params).toEqual([9, '旧记录B', '基础设施', 'active', 2, '乙', '2026-02-01'])
    })

    it('旧 table.json 损坏：回退种子数据且不抛', async () => {
      db.readTable.mockResolvedValue('{ broken json')
      await expect(sqlRecordsBackend.prepare()).resolves.toBeUndefined()
      expect(db.dbTransaction.mock.calls[0][0]).toHaveLength(12)
    })
  })

  it('loadAll 按 id 降序读取并映射列名→驼峰字段', async () => {
    db.dbSelect.mockResolvedValue([dbRow(), dbRow({ id: 1, status: 'inactive' })])
    const rows = await sqlRecordsBackend.loadAll()
    const sql = db.dbSelect.mock.calls[0][0]
    expect(sql).toContain('FROM records')
    expect(sql).toContain('ORDER BY id DESC')
    expect(rows[0]).toEqual({
      id: 7,
      name: 'x',
      category: '数据服务',
      status: 'active',
      amount: 100,
      owner: '张三',
      createdAt: '2026-09-24',
    })
    expect(rows[1].status).toBe('inactive')
  })

  it('insert 用 lastInsertId 回填新行，参数含今日日期', async () => {
    db.dbExecute.mockResolvedValueOnce({ changes: 1, lastInsertId: 42 })
    const created = await sqlRecordsBackend.insert({
      name: '新记录',
      category: '业务应用',
      status: 'active',
      amount: 66,
      owner: '丙',
    })
    expect(created.id).toBe(42)
    expect(created.name).toBe('新记录')
    expect(created.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    const [sql, params] = db.dbExecute.mock.calls[0]
    expect(sql).toContain('INSERT INTO records')
    expect(sql).toContain('VALUES (?1, ?2, ?3, ?4, ?5, ?6)')
    expect(params.slice(0, 5)).toEqual(['新记录', '业务应用', 'active', 66, '丙'])
  })

  it('update 更新六字段并锁定 WHERE id 占位符', async () => {
    await sqlRecordsBackend.update(9, {
      name: '改后',
      category: '安全合规',
      status: 'inactive',
      amount: 5,
      owner: '丁',
    })
    const [sql, params] = db.dbExecute.mock.calls[0]
    expect(sql).toContain('UPDATE records SET')
    expect(sql).toContain('WHERE id = ?6')
    expect(params).toEqual(['改后', '安全合规', 'inactive', 5, '丁', 9])
  })

  it('remove 把每个 id 作为独立参数（?1,?2,…），杜绝字符串拼接注入', async () => {
    await sqlRecordsBackend.remove([1, 2, 3])
    const [sql, params] = db.dbExecute.mock.calls[0]
    expect(sql).toContain('DELETE FROM records WHERE id IN (?1, ?2, ?3)')
    expect(params).toEqual([1, 2, 3])
  })

  it('remove 恶意关键字 id 也只能是参数不是 SQL 片段', async () => {
    // id 类型是 number，注入面本就被类型挡住；这里守护"永远参数化"的约定
    await sqlRecordsBackend.remove([0])
    expect(db.dbExecute.mock.calls[0][1]).toEqual([0])
  })

  it('remove 空数组不打后端', async () => {
    await sqlRecordsBackend.remove([])
    expect(db.dbExecute).not.toHaveBeenCalled()
  })

  it('resetSeed 清表重写内置种子（保留种子 ID）', async () => {
    await sqlRecordsBackend.resetSeed()
    expect(db.dbExecute).toHaveBeenCalledWith('DELETE FROM records', [])
    const statements = db.dbTransaction.mock.calls[0]?.[0]
    expect(statements).toHaveLength(SEED_ROWS.length)
    expect(statements?.[0]?.params?.[0]).toBe(SEED_ROWS[0]?.id)
  })
})