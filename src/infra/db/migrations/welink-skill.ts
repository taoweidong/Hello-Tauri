/**
 * migration v5：回复任务表增加技能路由留痕三列（skill-routing 设计 §9）。
 *
 *  * `skill_id`：命中技能的稳定 ID（内置兜底技能恒为 'fallback'）；
 *  * `skill_name`：**名称快照** —— 技能后续改名/删除，历史任务展示不变脸（对齐建群模板快照思路）；
 *  * `skill_source`：分类来源 rule/llm/fallback；空串 = 本变更前的老数据（展示层按「—」处理）。
 *
 * 无外键：技能配置存 config.json（决策 S-B），SQLite 不建技能表。
 * 幂等性由 `_migrations` 版本记录保证（已应用版本不重跑），ALTER 对存量库一次生效。
 */
import type { Migration } from '@/types'

export const migrationV5: Migration = {
  version: 5,
  description: 'add_welink_job_skill_columns',
  sql: `
ALTER TABLE welink_reply_jobs ADD COLUMN skill_id TEXT NOT NULL DEFAULT '';
ALTER TABLE welink_reply_jobs ADD COLUMN skill_name TEXT NOT NULL DEFAULT '';
ALTER TABLE welink_reply_jobs ADD COLUMN skill_source TEXT NOT NULL DEFAULT '';
`,
}
