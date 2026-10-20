/**
 * migration v10：给「已发送时间」的三条热谓词补索引（安全闸预热 + 沉淀水位扫描）。
 *
 * 背景（与 v9 同源的教训：**索引要对着谓词建，不是「有就行」**）：
 * `welink_reply_jobs.finished_at` 建表以来只有 `idx_wrj_status(status)`、
 * `idx_wrj_trigger(trigger_type, created_at)`、`idx_wrj_target(target_id, created_at)`
 * 三条，**没有一条覆盖 `finished_at`**。而下面三条查询都以它为主谓词：
 *
 *  1. `countSentSince(targetId, since)`（`repos/welink.ts`）：安全闸的「该会话近一时
 *     段发了多少条」。Gate 预热在启动恢复时对**每个监控会话**都跑一次 —— N 个会话
 *     就是 N 次全表扫描，冷启动直接变慢。
 *  2. `countGlobalSentSince(since)`：全局小时配额，同上。
 *  3. `listSentQaSince(since, lastId, limit)`（`repos/sediment.ts`）：知识沉淀的水位
 *     扫描，每轮一轮，`ORDER BY finished_at, id`。
 *
 * **实测（EXPLAIN QUERY PLAN，勿凭推断）**：v9 为止这三条**不是全表扫描**，而是
 * 「定位到了但范围没收窄」——
 *
 *  | 查询                  | v9 为止                                       | 加 v10 之后                                     |
 *  | --------------------- | --------------------------------------------- | ----------------------------------------------- |
 *  | `countSentSince`      | `SEARCH … idx_wrj_target (target_id=?)`       | `… idx_wrj_target_finished (target_id=? AND finished_at>?)` |
 *  | `countGlobalSentSince`| `SEARCH … idx_wrj_status (status=?)`          | `… idx_wrj_status_finished (status=? AND finished_at>?)`    |
 *  | `listSentQaSince`     | `… idx_wrj_status` + `USE TEMP B-TREE ORDER BY` | 同上且**排序步骤消失**                        |
 *
 * 即收益有两部分：① `status='sent'` 是低选择性谓词（多数行都命中），旧索引只能
 * 把它后面**所有**行扫一遍再过滤时间；② 沉淀水位扫描原本要额外建临时 B-tree 排序，
 * `(status, finished_at)` 的顺序本身就是 `ORDER BY` 的键，排序步骤直接省掉。
 *
 * 为什么建两条而不是一条：`idx_wrj_target_finished(target_id, finished_at)` 覆盖
 * 1（最左列是等值 `target_id`，第二列走范围）；`idx_wrj_status_finished(status,
 * finished_at)` 覆盖 2 与 3（这两条没有 `target_id`，只有 `status='sent'` 的等值前缀）。
 *
 * 为什么用 CREATE INDEX IF NOT EXISTS：与 v7/v8/v9 同口径 —— 迁移可能被重复执行
 * （`_migrations` 记录丢失、用户换存储根等），IF NOT EXISTS 保证幂等，
 * 且不覆盖已有同名索引。
 */
import type { Migration } from '@/types'

export const migrationV10: Migration = {
  version: 10,
  description: 'index_welink_reply_jobs_finished_at',
  sql: `
CREATE INDEX IF NOT EXISTS idx_wrj_target_finished ON welink_reply_jobs(target_id, finished_at);
CREATE INDEX IF NOT EXISTS idx_wrj_status_finished ON welink_reply_jobs(status, finished_at);
`,
}
