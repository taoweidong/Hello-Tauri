/**
 * migration v6：知识沉淀域四张表（knowledge-sedimentation 设计 K-B/K-D）。
 *
 *  * `welink_announcements`：群公告存档（此前公告类正文在 normalize 阶段被占位符
 *    丢弃，无任何存储）；`ann_uid` UNIQUE = 幂等去重键（对齐 welink_messages.msg_uid）。
 *  * `knowledge_drafts`：LLM 提取的知识条目先落待评审队列（评审即可信化闸门，K-E），
 *    `content_hash` 支撑指纹去重；`source_refs` 为 JSON 数组文本（来源消息 uid / job pk 等，
 *    供评审时回溯原料）；通过后写 knowledge/*.md，本表只留评审痕迹。
 *  * `sediment_state`：kv 水位（消息 pk / 公告 / 问答 finished_at / 连续失败计数）——
 *    运行态不进 config.json（K-B：配置归一化会误伤）。
 *  * `sediment_logs`：沉淀提取的大模型调用留痕。**不复用 welink_agent_logs**——后者
 *    job_pk NOT NULL 且外键指向回复任务（宿主 PRAGMA foreign_keys=ON），沉淀调用无 job
 *    可挂；独立同形表既保住 R4 语料「按 job 归属」的既有语义，又让沉淀卡可回溯提取过程。
 *
 * 幂等性由 `_migrations` 版本记录保证（已应用版本不重跑）。
 */
import type { Migration } from '@/types'

export const migrationV6: Migration = {
  version: 6,
  description: 'create_knowledge_sedimentation',
  sql: `
CREATE TABLE welink_announcements (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  ann_uid      TEXT NOT NULL UNIQUE,
  conv_pk      INTEGER NOT NULL REFERENCES welink_conversations(id) ON DELETE CASCADE,
  title        TEXT NOT NULL DEFAULT '',
  content      TEXT NOT NULL,
  published_at TEXT NOT NULL,
  created_at   TEXT NOT NULL
);
CREATE INDEX idx_wan_conv_time ON welink_announcements(conv_pk, published_at);

CREATE TABLE knowledge_drafts (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  title        TEXT NOT NULL,
  content      TEXT NOT NULL,
  topic        TEXT NOT NULL DEFAULT '',
  source_type  TEXT NOT NULL CHECK (source_type IN ('message','announcement','qa')),
  source_refs  TEXT NOT NULL DEFAULT '[]',
  content_hash TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  review_note  TEXT NOT NULL DEFAULT '',
  created_at   TEXT NOT NULL,
  reviewed_at  TEXT
);
CREATE INDEX idx_kd_status ON knowledge_drafts(status, created_at);
CREATE INDEX idx_kd_hash ON knowledge_drafts(content_hash);

CREATE TABLE sediment_state (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE sediment_logs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  prompt     TEXT NOT NULL,
  response   TEXT NOT NULL DEFAULT '',
  status     TEXT NOT NULL CHECK (status IN ('ok','error','timeout')),
  latency_ms INTEGER NOT NULL DEFAULT 0,
  error      TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
`,
}
