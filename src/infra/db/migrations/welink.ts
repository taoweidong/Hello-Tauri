/**
 * migration v2：WeLink 助手四张表（设计 §4）。
 *
 * 表结构要点（改动前务必回看设计文档，这些列都有明确语义）：
 *  * `welink_conversations` 冗余汇总列（O3）：`last_msg_at`/`unread_count`/`mention_count`/
 *    `last_active` 由 `applyPollResult` / `markRead` 同事务维护，使会话列表查询退化为
 *    **零聚合纯读**；`mute_until`（O11）与 `auto_reply`（L3）都是「存档与回复分离」的体现。
 *  * `welink_messages.msg_uid` UNIQUE = 幂等去重键（重复拉取安全）。
 *  * `welink_reply_jobs.draft` 与 `status='ready'` **同条 UPDATE** 写入（要点3：
 *    库中无草稿不得外发）；`skip_reason`/`hold_reason` 是两个不同维度的留痕：
 *    前者=Gate 拦下（不再发送），后者=等人工处理（reviewCount 依据，O7）。
 *  * `welink_agent_logs` 独立建表 1:N（D7）：重试/换答多次调用各自留痕，可导出回溯。
 */
import type { Migration } from '@/types'

export const migrationV2: Migration = {
  version: 2,
  description: 'create_welink_assistant',
  sql: `
CREATE TABLE welink_conversations (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  conv_type     TEXT NOT NULL CHECK (conv_type IN ('group','private')),
  conv_id       TEXT NOT NULL UNIQUE,
  title         TEXT NOT NULL DEFAULT '',
  remark        TEXT NOT NULL DEFAULT '',
  watching      INTEGER NOT NULL DEFAULT 0,
  auto_reply    INTEGER NOT NULL DEFAULT 0,
  mute_until    TEXT,
  last_msg_at   TEXT NOT NULL DEFAULT '',
  unread_count  INTEGER NOT NULL DEFAULT 0,
  mention_count INTEGER NOT NULL DEFAULT 0,
  last_active   TEXT NOT NULL DEFAULT '',
  last_cursor   TEXT NOT NULL DEFAULT '',
  updated_at    TEXT NOT NULL
);

CREATE TABLE welink_messages (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  msg_uid       TEXT NOT NULL UNIQUE,
  conv_pk       INTEGER NOT NULL REFERENCES welink_conversations(id) ON DELETE CASCADE,
  direction     TEXT NOT NULL CHECK (direction IN ('in','out')),
  sender_id     TEXT NOT NULL DEFAULT '',
  sender_name   TEXT NOT NULL DEFAULT '',
  content       TEXT NOT NULL,
  msg_type      TEXT NOT NULL DEFAULT 'text',
  at_me         INTEGER NOT NULL DEFAULT 0,
  read_flag     INTEGER NOT NULL DEFAULT 0,
  sent_at       TEXT NOT NULL,
  created_at    TEXT NOT NULL
);
CREATE INDEX idx_wm_conv_time ON welink_messages(conv_pk, sent_at);
CREATE INDEX idx_wm_direction ON welink_messages(direction, sent_at);

CREATE TABLE welink_reply_jobs (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  trigger_msg_pk   INTEGER NOT NULL REFERENCES welink_messages(id),
  trigger_type     TEXT NOT NULL CHECK (trigger_type IN ('group_at_me','private','manual')),
  target_type      TEXT NOT NULL CHECK (target_type IN ('group','private')),
  target_id        TEXT NOT NULL,
  send_mode_used   TEXT NOT NULL DEFAULT 'auto',
  context_snapshot TEXT NOT NULL DEFAULT '',
  draft            TEXT NOT NULL DEFAULT '',
  status           TEXT NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending','discussing','ready','sending','sent','failed','skipped')),
  attempts         INTEGER NOT NULL DEFAULT 0,
  last_error       TEXT NOT NULL DEFAULT '',
  skip_reason      TEXT NOT NULL DEFAULT '',
  hold_reason      TEXT NOT NULL DEFAULT '',
  rating           TEXT CHECK (rating IN ('up','down')),
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  finished_at      TEXT
);
CREATE INDEX idx_wrj_status ON welink_reply_jobs(status);
CREATE INDEX idx_wrj_trigger ON welink_reply_jobs(trigger_type, created_at);
CREATE INDEX idx_wrj_target ON welink_reply_jobs(target_id, created_at);

CREATE TABLE welink_agent_logs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  job_pk        INTEGER NOT NULL REFERENCES welink_reply_jobs(id) ON DELETE CASCADE,
  seq           INTEGER NOT NULL,
  prompt        TEXT NOT NULL,
  response      TEXT NOT NULL DEFAULT '',
  status        TEXT NOT NULL CHECK (status IN ('ok','error','timeout')),
  latency_ms    INTEGER NOT NULL DEFAULT 0,
  error         TEXT NOT NULL DEFAULT '',
  created_at    TEXT NOT NULL
);
CREATE INDEX idx_wal_job ON welink_agent_logs(job_pk);
`,
}
