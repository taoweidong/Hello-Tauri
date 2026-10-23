/**
 * migration v12：给 `welink_announcements.created_at` 补索引（公告保留期清理）。
 *
 * 与 v11 是**同一个老毛病在第三个域的复现**：公告表从 v6 建表起只有
 * `idx_wan_conv_time(conv_pk, published_at)` —— 这个复合索引只能服务
 * 「按会话取公告」，对「按 `created_at` 过期清理」的谓词**用不上**（最左前缀不匹配），
 * 与 v9 的教训完全同构。
 *
 * 而公告是沉淀域里**唯一一张既无保留期、又持续写入**的表：每轮沉淀采集按白名单
 * 会话拉公告（`pullAnnouncements` → `applyAnnouncements`），群越多写得越快；
 * v6 至今五个版本从没清理过它。留痕（v11）好歹还有个 `clearSedimentLogs` 接口，
 * 公告连接口都没有 —— 这是「清理缺的不是实现，是调度」的第四次复现。
 *
 * 所以本迁移只做一件事：让「按时间分批清理」有索引可用。清理语义与
 * `purgeSedimentLogsBefore` 同构（子查询 + `LIMIT`，**不写 `ORDER BY id`**，
 * 否则 SQLite 会放弃本索引改走 rowid 全表扫描）。
 *
 * 幂等：与 v7–v11 同口径用 `CREATE INDEX IF NOT EXISTS`。
 */
import type { Migration } from '@/types'

export const migrationV12: Migration = {
  version: 12,
  description: 'index_announcements_created_at',
  sql: `
CREATE INDEX IF NOT EXISTS idx_wan_created_at ON welink_announcements(created_at);
`,
}
