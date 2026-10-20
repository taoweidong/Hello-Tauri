/**
 * migration v11：给 `sediment_logs.created_at` 补索引（沉淀留痕的保留期清理）。
 *
 * 背景是第五轮勘察抓到的「清理缺的不是实现，是调度」的老毛病在新域里的完整复现：
 * `sediment_logs` 从 v6 建表起**没有任何索引**，v7/v8/v9/v10 四轮补索引都绕过了它；
 * 而 `clearSedimentLogs()` 这个清理入口写好后**从未有人调用**，且实现是
 * `DELETE FROM sediment_logs` —— 全表一次删、不分批。
 *
 * 三条问题叠加的后果：
 *  1. 每轮沉淀提取写一条留痕，内容是完整 prompt（上限 8000 字）+ response，
 *     单条 10 KB 量级，表只增不减；
 *  2. 真把它接进 `retention` 也不合用：几万行库上一次全表 DELETE 会长时间独占
 *     SQLite 全局 Mutex —— 正是 v7 注释里警告的形态；
 *  3. 即便改成按时间分批，没有 `created_at` 索引就仍然是每轮全表扫。
 *
 * 所以本迁移只做一件事：让「按时间分批清理」有索引可用。分批语义与
 * `purgeAgentLogsBefore` 同构（`WHERE created_at < ? LIMIT ?` 的子查询 + IN），
 * 同样**不写 ORDER BY id**，否则 SQLite 会放弃本索引改走 rowid 全表扫描。
 *
 * 幂等：与 v7–v10 同口径用 `CREATE INDEX IF NOT EXISTS`。
 */
import type { Migration } from '@/types'

export const migrationV11: Migration = {
  version: 11,
  description: 'index_sediment_logs_created_at',
  sql: `
CREATE INDEX IF NOT EXISTS idx_slog_created_at ON sediment_logs(created_at);
`,
}
