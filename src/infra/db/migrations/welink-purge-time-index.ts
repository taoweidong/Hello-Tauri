/**
 * migration v9：给「按时间清理」的两条谓词补索引（保留期清理的第二组前置条件）。
 *
 * 背景：v7 只补了 `NOT EXISTS` 子查询那一侧的索引（`idx_wrj_trigger_msg`），
 * **外层的时间谓词本身仍然全表扫描** —— 索引不是「有就行」，要对着谓词看：
 *
 *  1. `purgeMessagesBefore` 的外层是 `WHERE m.sent_at < ?`。现有索引是
 *     `(conv_pk, sent_at)` 与 `(direction, sent_at)`，两条的最左列都不是
 *     `sent_at`，对裸 `sent_at` 谓词**完全用不上**（最左前缀原则），只能全表扫。
 *  2. `purgeAgentLogsBefore` 的 `WHERE created_at < ?` 更彻底：`welink_agent_logs`
 *     此前**只有** `idx_wal_job(job_pk)`，`created_at` 一列索引都没有。
 *
 * 清理是「每轮 20 批 × 每批扫一遍」的循环作业（`retention.ts`），保留期一到就在
 * 7×24 常驻的后台反复跑。全表扫不只是慢 —— 它长时间独占 SQLite 全局连接锁
 * （`db.rs` 的 `with_db` 是 Mutex），期间**所有** DB 命令排队，表现为应用整体卡顿。
 *
 * 为什么用 CREATE INDEX IF NOT EXISTS：与 v7/v8 同口径 —— 迁移可能被重复执行
 * （`_migrations` 记录丢失、用户换存储根等），IF NOT EXISTS 保证幂等，
 * 且不覆盖已有同名索引。
 */
import type { Migration } from '@/types'

export const migrationV9: Migration = {
  version: 9,
  description: 'index_welink_messages_sent_at_and_agent_logs_created_at',
  sql: `
CREATE INDEX IF NOT EXISTS idx_wm_sent_at ON welink_messages(sent_at);
CREATE INDEX IF NOT EXISTS idx_wal_created_at ON welink_agent_logs(created_at);
`,
}
