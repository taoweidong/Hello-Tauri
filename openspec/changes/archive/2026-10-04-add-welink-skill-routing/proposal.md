# Proposal

## Why

自动回复生成段目前对所有问题共用唯一全局 `promptTemplate`，无法区分用户咨询的问题类型
（故障咨询 / 进度查询 / 资料索取 / 制度问答……），也就无法按类型定制回复人设、规则与业务
口径；模型只能靠通用能力作答，S7 黑名单只能兜住承诺性/资金类幻觉，治标不治本。R4 语料的
👍/👎 评价也因缺少分类维度而无法分层统计。外发闭环（轮询 → 生成 → 安全闸 → 防双发）已被
测试钉住且质量稳定，本次只动生成段入口，把「一个模板」升级为「分类路由 + 技能清单」。

## What Changes

- **新增分类步骤**（生成段 `generateOne` 内、渲染提示词前）：规则关键词/正则优先命中 →
  未命中且开关开启时 LLM 分类兜底（复用 `agent.complete`，调用自动落 `welink_agent_logs`）→
  内置兜底技能终兜底。任何分支不 reject、不阻断主链路。
- **新增技能模型与配置**：`WelinkSkill`（id/名称/说明/启停/关键词/专属模板/静态知识块/
  reviewMode），存 `WelinkAgentSettings.skills` 随 config.json 持久化；内置不可删除的
  兜底技能（模板即现有 `promptTemplate` 字段，老配置零迁移）；归一化收敛（≤20 条、id
  去重、keywords 清洗）。
- **提示词按技能渲染**：命中技能使用其专属模板并注入静态知识块（新增 `{{knowledge}}`
  占位符）；会话内容消毒规则不变。
- **任务留痕扩展（migration v5）**：`welink_reply_jobs` 增加 `skill_id/skill_name/skill_source`
  三列（`skill_name` 为快照，技能删改后历史不变脸；无外键）。
- **技能强制人工审核**：`reviewMode='manual'` 的技能生成草稿后直接转人工待审
  （`hold_reason='skill_review'`，新增枚举值），不入自动外发队列，人工放行走既有
  `sendNow` 通道且安全闸其余规则照走。
- **UI**：`LlmSettingsCard` 新增「回复技能」编辑区（列表 CRUD + 关键词/模板/知识块/
  审核开关 + LLM 分类兜底开关），现有「提示词模板」区更名为「兜底技能（通用助手）」；
  回复历史 job 卡片显示技能徽标。
- **安全不变量（非功能，写死）**：安全闸不感知技能——L0–L3/S1–S8 判定与技能维度无关，
  技能只影响「生成什么」，绝不影响「能不能发」。

**不做（本期）**：向量检索/RAG、每技能独立 model/temperature、自动 prompt 优化闭环、
技能级安全闸差异、图片/文件消息路由、一 job 多技能叠加路由、system/user 消息分离
（协议已按单条 user 消息核实成立，列为扩展点）。

## Capabilities

### New Capabilities

（无。技能路由是自动回复生成段的内生行为，与回复任务、安全闸不变量同属一个内聚边界，
并入既有能力，不另立平行 spec。）

### Modified Capabilities

- `welink-auto-reply`: 新增「问题分类与技能路由」「技能配置与归一化」「技能知识注入」
  「技能强制人工审核」「安全闸不感知技能」五组需求（含分类来源留痕 rule/llm/fallback、
  兜底语义、快照留痕、转审不入自动外发队列的验收口径）；既有需求（轮询、草稿先落库、
  安全闸分级/配额/熔断、防双发、急停跨重启、演示剧本）全部不变。

## Impact

- **代码（TS 层为主，零 Rust 改动）**：
  - 改：`src/types/welink.ts`（类型/默认值/归一化/HoldReason）、
    `src/orchestrator/pipeline.ts`（generateOne 接入）、
    `src/infra/agent/prompt.ts`（`{{knowledge}}`）、
    `src/infra/db/ports.ts`、`src/infra/db/repos/welink.ts`、`welink-memory.ts`（列映射）、
    `src/components/welink/LlmSettingsCard.vue`、回复历史组件（技能徽标）。
  - 增：`src/orchestrator/skill-router.ts`（分类器，纯函数三件套 + 异步入口）、
    `src/infra/db/migrations/` v5。
- **数据**：`app.db` `welink_reply_jobs` 加三列（migration v5，老数据空串兼容）；
  `config.json` `weLink.agent` 新增 `skills` / `llmClassifyFallback`（老配置零迁移）。
- **测试**：types/skill-router/pipeline/db 契约/LlmSettingsCard 各补 spec 用例；
  `orchestrator/**` 92% lines、`infra/db/**` 72% lines 覆盖率基线不得回退。
- **依赖**：零新增。
- **方案细节与决策记录**：`docs/design-welink-skill-routing-2026-10-04.md`（S-A~S-J）。
