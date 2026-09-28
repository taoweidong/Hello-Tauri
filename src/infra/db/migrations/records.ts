/**
 * migration v1：`records` 表（通用记录 CRUD 页的数据表）。
 *
 * 为什么单独成一个文件（R-4）：这段 SQL 曾经在**两处**各写一份 ——
 * `infra/db/index.ts` 的 `MIGRATIONS`（给 `dbMigrateAll` 用）与
 * `repositories/records.ts` 的 `MIGRATIONS`（给该仓储 `prepare()` 用），
 * 注释里还写着「逐字一致」。两份文本一旦漂移，就会出现「建表结构取决于
 * 谁先跑」这种极难排查的问题（而且已落库的库不会重跑迁移，缺陷会被掩盖很久）。
 *
 * 现在只有这一处定义，两边都 import 它。
 */
import type { Migration } from '@/types'

export const migrationV1: Migration = {
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
}
