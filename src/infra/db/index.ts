/**
 * 版本化迁移注册表（设计 §4）。
 *
 * 迁移定义**集中在这里**，各仓储不再各自声明 —— 应用启动时一次
 * `dbMigrateAll()`（幂等、后台执行、不阻塞首屏，设计 §5-P6），宿主侧
 * `_migrations` 表负责跟踪已应用版本，重复调用不会重跑。
 *
 * 为什么迁移 SQL 留在 TS 而不是 Rust：与「业务 SQL 全在 TS」同构（Q1）。
 * Rust 只有通用执行器，新增业务表 = 加一条迁移 + 写仓储，Rust 零改动。
 */
import { bridge, platform } from '@/api'
import type { Migration } from '@/types'
import type { WelinkRepository } from './ports'
import { sqlWelinkRepository } from './repos/welink'
import { memoryWelinkRepository } from './repos/welink-memory'
import { migrationV2 } from './migrations/welink'

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    description: 'create_records',
    // v1 与历史实现（repositories/records.ts）逐字一致：已落库的库不会被重复执行，
    // 但保持文本相同能让「迁移清单」成为唯一可信的表结构来源。
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
  migrationV2,
]

let migrated: Promise<number[]> | null = null

/**
 * 应用全部未执行的迁移。
 *
 * 结果按进程缓存：迁移是幂等的，但每次启动一次 IPC 往返即可；
 * 失败则**清空缓存**，允许后续（如用户修正配置后）重试，而不是永久卡在失败态。
 */
export function dbMigrateAll(): Promise<number[]> {
  if (!migrated) {
    migrated = bridge.dbMigrate(MIGRATIONS).catch((error: unknown) => {
      migrated = null
      throw error
    })
  }
  return migrated
}

/** 测试用：重置迁移缓存 */
export function resetMigrationCache() {
  migrated = null
}

let welinkRepo: WelinkRepository | null = null

/** WeLink 仓储单例（桌面 = SQLite；浏览器 = 内存实现，Q3/D5） */
export function welink(): WelinkRepository {
  if (!welinkRepo) {
    welinkRepo = platform === 'tauri' ? sqlWelinkRepository : memoryWelinkRepository
  }
  return welinkRepo
}

/** 测试用：替换仓储实现（注入假件） */
export function setWelinkRepository(repo: WelinkRepository | null) {
  welinkRepo = repo
}

export type { WelinkRepository } from './ports'
export type {
  ApplyResult,
  ApplyRules,
  ConversationDraft,
  InboxQuery,
  InboxThread,
  JobDraft,
  JobQuery,
  JobStats,
  MessageQuery,
} from './ports'