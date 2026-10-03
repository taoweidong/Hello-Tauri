/**
 * migration v4：CodeHub 检视域三表（personal-workbench）。
 *
 * 与前三个版本同一套纪律的检视版：
 *  * **快照覆盖写**：MR 表以 (repo_id, mr_iid) 为主键，同步一律 upsert —— 同一 MR
 *    重复同步不产生重复行，数据量有界（不留历史版本，spec「快照落库与离线只读降级」）；
 *  * **可筛字段列存**：state/author/updated_at/检视摘要进列（筛选与排序不走 JSON），
 *    详情（描述 + 评论）整包进 `detail_json` 可空列 —— 只读快照没有关联查询需求，
 *    不值得为评论单独建表（design D4）；
 *  * **显式级联**：删仓库时由仓储在事务里显式删快照与同步状态，不依赖
 *    PRAGMA foreign_keys 的开启状态 —— 依赖宿主编译开关的级联是隐式行为。
 */
import type { Migration } from '@/types'

export const migrationV4: Migration = {
  version: 4,
  description: 'create_codehub_review',
  sql: `
CREATE TABLE codehub_repos (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_id    TEXT NOT NULL UNIQUE,
  name       TEXT NOT NULL DEFAULT '',
  enabled    INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  created_at TEXT NOT NULL
);

CREATE TABLE codehub_mrs (
  repo_id          TEXT NOT NULL,
  mr_iid           TEXT NOT NULL,
  title            TEXT NOT NULL,
  state            TEXT NOT NULL CHECK (state IN ('open','merged','closed')),
  author           TEXT NOT NULL DEFAULT '',
  source_branch    TEXT NOT NULL DEFAULT '',
  target_branch    TEXT NOT NULL DEFAULT '',
  updated_at       TEXT NOT NULL DEFAULT '',
  web_url          TEXT NOT NULL DEFAULT '',
  reviewers        TEXT NOT NULL DEFAULT '[]',
  approvals        INTEGER NOT NULL DEFAULT 0,
  unresolved       INTEGER NOT NULL DEFAULT 0,
  last_activity_at TEXT NOT NULL DEFAULT '',
  detail_json      TEXT,
  synced_at        TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (repo_id, mr_iid)
);
CREATE INDEX idx_cm_state ON codehub_mrs(state);
CREATE INDEX idx_cm_updated ON codehub_mrs(updated_at);

CREATE TABLE codehub_sync_state (
  repo_id        TEXT PRIMARY KEY,
  last_synced_at TEXT,
  last_error     TEXT
);
`,
}
