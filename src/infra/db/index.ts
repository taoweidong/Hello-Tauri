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
import type { CodeHubRepository } from './codehub-ports'
import type { GroupRepository } from './group-ports'
import type { WelinkRepository } from './ports'
import { sqlCodehubRepository } from './repos/codehub'
import { memoryCodehubRepository } from './repos/codehub-memory'
import { sqlGroupRepository } from './repos/welink-group'
import { memoryGroupRepository } from './repos/welink-group-memory'
import { sqlWelinkRepository } from './repos/welink'
import { memoryWelinkRepository } from './repos/welink-memory'
import { migrationV1 } from './migrations/records'
import { migrationV2 } from './migrations/welink'
import { migrationV3 } from './migrations/group'
import { migrationV4 } from './migrations/codehub'

/**
 * 全库迁移注册表（**唯一真值**）。
 *
 * R-4：v1 的 SQL 曾经在 `repositories/records.ts` 里另有一份「逐字一致」的
 * 声明 —— 两份文本靠人肉同步，漂移后建表结构取决于谁先跑，且已落库的库不会
 * 重跑迁移，缺陷会被掩盖很久。现在两边都 import 同一份定义。
 */
export const MIGRATIONS: Migration[] = [migrationV1, migrationV2, migrationV3, migrationV4]

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

let groupRepo: GroupRepository | null = null

/** 快速建群仓储单例（桌面 = SQLite；浏览器 = 内存实现，Q3/D5） */
export function group(): GroupRepository {
  if (!groupRepo) {
    groupRepo = platform === 'tauri' ? sqlGroupRepository : memoryGroupRepository
  }
  return groupRepo
}

/** 测试用：替换建群仓储实现（注入假件） */
export function setGroupRepository(repo: GroupRepository | null) {
  groupRepo = repo
}

let codehubRepo: CodeHubRepository | null = null

/** CodeHub 检视仓储单例（桌面 = SQLite；浏览器 = 内存实现，Q3/D5） */
export function codehub(): CodeHubRepository {
  if (!codehubRepo) {
    codehubRepo = platform === 'tauri' ? sqlCodehubRepository : memoryCodehubRepository
  }
  return codehubRepo
}

/** 测试用：替换检视仓储实现（注入假件） */
export function setCodehubRepository(repo: CodeHubRepository | null) {
  codehubRepo = repo
}

export type { WelinkRepository } from './ports'
export type { GroupRepository } from './group-ports'
export type { GroupJobQuery } from './group-ports'
export type { CodeHubRepository, CodeHubMrQuery } from './codehub-ports'
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
