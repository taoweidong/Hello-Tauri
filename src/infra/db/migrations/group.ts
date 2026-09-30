/**
 * migration v3：快速建群两张表。
 *
 * 与自动回复（migration v2）共用同一套铁律的建群版：
 *  * **先留痕后外呼**：建群是对外动作（拉真人进群），发起 CLI 调用**之前**必须先
 *    在 `welink_group_jobs` 落一条 `status='pending'` —— 进程中断/超时后至少留下
 *    「何时、用哪个模板、拉了谁」的审计凭据，启动清扫把未知结局标为 interrupted。
 *  * `template_pk` 可空（手工建群不挂模板），`template_name`/`members` 是**快照列**：
 *    历史记录不能因为模板后来被改被删而变脸，所以存当时用过的值，不联表读。
 *  * 成员列表存逗号串而非子表：工号清单量级小（几十），归一化入口保证无空项无
 *    重复（`normalizeMemberIds`），不值得为它加一张表和一组级联规则。
 */
import type { Migration } from '@/types'

export const migrationV3: Migration = {
  version: 3,
  description: 'create_group_builder',
  sql: `
CREATE TABLE welink_group_templates (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  group_name  TEXT NOT NULL DEFAULT '',
  members     TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE welink_group_jobs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  template_pk   INTEGER REFERENCES welink_group_templates(id) ON DELETE SET NULL,
  template_name TEXT NOT NULL DEFAULT '',
  group_name    TEXT NOT NULL,
  members       TEXT NOT NULL DEFAULT '',
  status        TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','success','failed','interrupted')),
  group_id      TEXT NOT NULL DEFAULT '',
  error         TEXT NOT NULL DEFAULT '',
  created_at    TEXT NOT NULL,
  finished_at   TEXT
);
CREATE INDEX idx_wgj_created ON welink_group_jobs(created_at);
CREATE INDEX idx_wgj_status ON welink_group_jobs(status);
`,
}
