/**
 * migration v13：给 `knowledge_drafts.reviewed_at` 补索引（待评审条目保留期清理）。
 *
 * 「清理缺的不是实现，是调度」的第五次复现：v6 建表起本表只有
 * `idx_kd_status(status, created_at)` 与 `idx_kd_hash(content_hash)` ——
 * 前者最左前缀是 status，对「按评审时刻过期清理」的谓词用不上；后者只服务
 * 入库预检。而 `insertDrafts` 每轮沉淀都在写，approved/rejected 只标记不删除，
 * 终态条目永久驻留。
 *
 * 本迁移只做一件事：让「按 `reviewed_at` 分批清理已决条目」有索引可用。
 * 清理语义与 `purgeAnnouncementsBefore` 同构（子查询 + `LIMIT`，**不写
 * `ORDER BY id`**，否则 SQLite 放弃本索引改走 rowid 全表扫描），且**只清
 * 已决状态** —— pending 的 `reviewed_at` 为 NULL，天然不匹配 `< cutoff`。
 *
 * 幂等：与 v7–v12 同口径用 `CREATE INDEX IF NOT EXISTS`。
 */
import type { Migration } from '@/types'

export const migrationV13: Migration = {
  version: 13,
  description: 'index_knowledge_drafts_reviewed_at',
  sql: `
CREATE INDEX IF NOT EXISTS idx_kd_reviewed_at ON knowledge_drafts(reviewed_at);
`,
}
