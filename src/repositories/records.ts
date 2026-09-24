import { bridge, platform } from '@/api'
import type { DbRow, Migration, TableRow, TableRowDraft } from '@/types'
import { logger } from '@/utils/logger'

export const CATEGORIES = ['基础设施', '数据服务', '业务应用', '安全合规']

export const SEED_ROWS: TableRow[] = [
  { id: 1, name: '日志采集网关', category: '基础设施', status: 'active', amount: 12800, owner: '张伟', createdAt: '2026-01-08' },
  { id: 2, name: '订单查询服务', category: '业务应用', status: 'active', amount: 35600, owner: '李娜', createdAt: '2026-01-22' },
  { id: 3, name: '离线报表任务', category: '数据服务', status: 'inactive', amount: 7400, owner: '王强', createdAt: '2026-02-03' },
  { id: 4, name: '统一认证中心', category: '安全合规', status: 'active', amount: 52100, owner: '赵敏', createdAt: '2026-02-17' },
  { id: 5, name: '配置中心', category: '基础设施', status: 'active', amount: 9600, owner: '陈杰', createdAt: '2026-03-05' },
  { id: 6, name: '数据同步管道', category: '数据服务', status: 'active', amount: 28300, owner: '刘洋', createdAt: '2026-03-19' },
  { id: 7, name: '审计日志归档', category: '安全合规', status: 'inactive', amount: 4300, owner: '孙倩', createdAt: '2026-04-02' },
  { id: 8, name: '移动端接口层', category: '业务应用', status: 'active', amount: 41200, owner: '周琳', createdAt: '2026-04-21' },
  { id: 9, name: '指标计算引擎', category: '数据服务', status: 'active', amount: 33800, owner: '吴昊', createdAt: '2026-05-09' },
  { id: 10, name: '容器镜像仓库', category: '基础设施', status: 'inactive', amount: 15900, owner: '郑凯', createdAt: '2026-05-26' },
  { id: 11, name: '风控规则服务', category: '安全合规', status: 'active', amount: 46700, owner: '冯雪', createdAt: '2026-06-11' },
  { id: 12, name: '消息推送平台', category: '业务应用', status: 'active', amount: 21400, owner: '许阳', createdAt: '2026-06-30' },
]

/** 用本地时区拼日期：toISOString() 是 UTC，东八区凌晨会记成前一天 */
export function today() {
  const now = new Date()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${now.getFullYear()}-${month}-${day}`
}

export function cloneSeed(): TableRow[] {
  return SEED_ROWS.map((row) => ({ ...row }))
}

/**
 * 二维记录仓储后端（Q1：SQL 全在 TS 侧，Rust 只有通用通道）。
 * store 只依赖这层语义接口，不感知底层是 SQLite 还是内存。
 */
export interface RecordsBackend {
  /** 建表 + 首次种子导入（幂等，loadAll 前必须调用） */
  prepare(): Promise<void>
  loadAll(): Promise<TableRow[]>
  insert(draft: TableRowDraft): Promise<TableRow>
  update(id: number, draft: TableRowDraft): Promise<void>
  remove(ids: number[]): Promise<void>
  /** 恢复示例数据：清表并写回种子（保留种子 ID） */
  resetSeed(): Promise<TableRow[]>
}

// ---------- SQLite 实现（桌面模式） ----------

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    description: 'create_records',
    sql: `CREATE TABLE records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      category TEXT NOT NULL,
      status TEXT NOT NULL,
      amount REAL NOT NULL DEFAULT 0,
      owner TEXT NOT NULL,
      created_at TEXT NOT NULL
    );`,
  },
]

type RowStatus = TableRow['status']

function rowFromDb(item: DbRow): TableRow {
  return {
    id: Number(item.id ?? 0),
    name: String(item.name ?? ''),
    category: String(item.category ?? ''),
    status: (item.status === 'inactive' ? 'inactive' : 'active') as RowStatus,
    amount: Number(item.amount ?? 0),
    owner: String(item.owner ?? ''),
    createdAt: String(item.created_at ?? ''),
  }
}

function rowParams(row: TableRow) {
  return [row.name, row.category, row.status, row.amount, row.owner, row.createdAt]
}

export const sqlRecordsBackend: RecordsBackend = {
  async prepare() {
    await bridge.dbMigrate(MIGRATIONS)
    const countRows = await bridge.dbSelect('SELECT COUNT(*) AS count FROM records')
    if (Number(countRows[0]?.count ?? 0) > 0) return

    // 表为空：优先导入旧版 table.json（P3 升级迁移），否则写内置种子
    let rows = cloneSeed()
    const legacy = await bridge.readTable().catch(() => null)
    if (legacy) {
      try {
        const parsed = JSON.parse(legacy) as TableRow[]
        if (Array.isArray(parsed) && parsed.length) {
          rows = parsed.filter((row) => Number.isFinite(row.id) && row.id > 0)
          logger.info(`从旧版 table.json 导入 ${rows.length} 条记录到 SQLite`)
        }
      } catch {
        logger.warn('旧版 table.json 解析失败，改用内置种子数据')
      }
    }
    await bridge.dbTransaction(
      rows.map((row) => ({
        sql: 'INSERT INTO records(id, name, category, status, amount, owner, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)',
        params: [row.id, ...rowParams(row)],
      })),
    )
  },

  async loadAll() {
    const rows = await bridge.dbSelect(
      'SELECT id, name, category, status, amount, owner, created_at FROM records ORDER BY id DESC',
    )
    return rows.map(rowFromDb)
  },

  async insert(draft) {
    const result = await bridge.dbExecute(
      'INSERT INTO records(name, category, status, amount, owner, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)',
      [draft.name, draft.category, draft.status, draft.amount, draft.owner, today()],
    )
    return { ...draft, id: result.lastInsertId, createdAt: today() }
  },

  async update(id, draft) {
    await bridge.dbExecute(
      'UPDATE records SET name = ?1, category = ?2, status = ?3, amount = ?4, owner = ?5 WHERE id = ?6',
      [draft.name, draft.category, draft.status, draft.amount, draft.owner, id],
    )
  },

  async remove(ids) {
    if (!ids.length) return
    const placeholders = ids.map((_, i) => `?${i + 1}`).join(', ')
    await bridge.dbExecute(`DELETE FROM records WHERE id IN (${placeholders})`, ids)
  },

  async resetSeed() {
    await bridge.dbExecute('DELETE FROM records', [])
    const rows = cloneSeed()
    await bridge.dbTransaction(
      rows.map((row) => ({
        sql: 'INSERT INTO records(id, name, category, status, amount, owner, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)',
        params: [row.id, ...rowParams(row)],
      })),
    )
    return rows
  },
}

// ---------- 内存实现（浏览器调试模式，Q3：不做真 SQL） ----------

const TABLE_KEY = 'hello-tauri:table'

function loadFromStorage(): TableRow[] | null {
  try {
    const raw = localStorage.getItem(TABLE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as TableRow[]
    return Array.isArray(parsed) && parsed.length ? parsed : null
  } catch {
    return null
  }
}

let memoryRows: TableRow[] | null = null

function rows(): TableRow[] {
  if (!memoryRows) {
    memoryRows = loadFromStorage() ?? cloneSeed()
  }
  return memoryRows
}

function flush() {
  try {
    localStorage.setItem(TABLE_KEY, JSON.stringify(memoryRows ?? []))
  } catch {
    // 配额异常只影响调试模式持久性，静默
  }
}

export const memoryRecordsBackend: RecordsBackend = {
  async prepare() {
    rows()
  },

  async loadAll() {
    return rows().map((row) => ({ ...row }))
  },

  async insert(draft) {
    const nextId = rows().reduce((max, row) => Math.max(max, row.id), 0) + 1
    const row: TableRow = { ...draft, id: nextId, createdAt: today() }
    rows().unshift(row)
    flush()
    return { ...row }
  },

  async update(id, draft) {
    const target = rows().find((row) => row.id === id)
    if (target) {
      Object.assign(target, draft)
      flush()
    }
  },

  async remove(ids) {
    if (!ids.length) return
    memoryRows = rows().filter((row) => !ids.includes(row.id))
    flush()
  },

  async resetSeed() {
    memoryRows = cloneSeed()
    flush()
    return memoryRows.map((row) => ({ ...row }))
  },
}

/** 按运行环境选择后端：桌面走 SQLite 通道，浏览器走内存实现 */
export const recordsBackend: RecordsBackend =
  platform === 'tauri' ? sqlRecordsBackend : memoryRecordsBackend