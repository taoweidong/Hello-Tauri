/**
 * migration v8：会话表的两条读路径索引（poller 热路径 + 会话列表排序）。
 *
 * 为什么现在补：全量勘察发现 `welink_conversations` 建表以来**没有任何索引**
 * ——v2 只给 welink_messages 建了索引，会话表一直靠全表扫描。两条查询都是
 * 高频路径：
 *
 *  1. `listWatching()`（`WHERE watching = 1 ORDER BY id LIMIT ?`）：poller
 *     **每一轮**都要跑一次，拿到「本轮要拉哪些会话」。它是整个自动回复的入口，
 *     会话数增长后每轮一次全表扫描会直接抬高轮询成本（本应用 7×24 常驻）。
 *  2. `listConversations()`（`ORDER BY conv_type, last_msg_at DESC`）：收件箱与
 *     配置页的会话列表，无索引时靠内存临时 B-tree 排序。
 *
 * 为什么两条一起建（而不是只建 watching）：`idx_wc_watching` 只有一列、
 * 选择性很低（0/1），单独建能让 poller 走索引定位，但列表排序仍要全表扫后排序；
 * `idx_wc_type_last` 覆盖排序键，让 `ORDER BY` 直接走索引顺序，省掉排序步骤。
 *
 * 为什么用 CREATE INDEX IF NOT EXISTS：与 v7 同口径 —— 迁移可能被重复执行
 * （`_migrations` 记录丢失、用户换存储根等），IF NOT EXISTS 保证幂等，
 * 且不覆盖已有同名索引。
 */
import type { Migration } from '@/types'

export const migrationV8: Migration = {
  version: 8,
  description: 'index_welink_conversations_watching_and_order',
  sql: `
CREATE INDEX IF NOT EXISTS idx_wc_watching ON welink_conversations(watching);
CREATE INDEX IF NOT EXISTS idx_wc_type_last ON welink_conversations(conv_type, last_msg_at DESC);
`,
}
