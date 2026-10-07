/**
 * migration v7：为 `welink_reply_jobs.trigger_msg_pk` 补索引（保留期清理的前置条件）。
 *
 * 为什么必须有这条：`purgeMessagesBefore` 要跳过「仍被 job 引用」的消息，判定写成
 * `NOT EXISTS (SELECT 1 FROM welink_reply_jobs j WHERE j.trigger_msg_pk = m.id)`。
 * 该列**无索引**时这条子查询退化为对 jobs 表的全表扫描（EXPLAIN 实测：
 * `CORRELATED SCALAR SUBQUERY → SCAN j`），且它对每条候选消息都执行一次 ——
 * 5 万消息 + 5 万 job 的库上单批 DELETE 实测 **21.8 秒**；补索引后同一语句
 * **8.3 毫秒**（`SEARCH j USING COVERING INDEX`，差约 2600 倍）。
 *
 * 清理任务是每日后台跑的，单条 21.8 秒尚可接受，但它会长时间独占 SQLite 全局连接锁
 * （db.rs 的 `with_db` 是Mutex），期间**所有** DB 命令排队 —— 表现为应用整体卡顿。
 * 所以这个索引不是可选优化，而是该修复能上线的必要条件。
 *
 * 为什么用 CREATE INDEX IF NOT EXISTS：迁移可能被重复执行（`_migrations` 记录丢失、
 * 用户换存储根等），IF NOT EXISTS 让它幂等且不覆盖已有索引。
 */
import type { Migration } from '@/types'

export const migrationV7: Migration = {
  version: 7,
  description: 'index_welink_reply_jobs_trigger_msg',
  sql: `
CREATE INDEX IF NOT EXISTS idx_wrj_trigger_msg ON welink_reply_jobs(trigger_msg_pk);
`,
}
