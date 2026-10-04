# Design

> 完整方案（现状盘点、决策记录 S-A~S-J、UI 细节、测试计划、实施清单）已定稿于
> `docs/design-welink-skill-routing-2026-10-04.md`，本文为实施视角的决策提炼，两者不一致时
> 以本文为准（本文为后定稿的评审产物）。

## Context

生成段（`orchestrator/pipeline.ts` `generateOne`）现为单一全局模板直发 LLM：
`recentContext → renderPrompt → agent.complete → sanitizeReply → commitDraft(draft+ready 原子落库)`。
外发段（SafetyGate 十六道闸 → welink-cli send 防双发）与轮询/触发/留痕链路被测试钉住，
本次零改动。LLM 连接层（OpenAI 兼容）已真实对接核实。约束：内网离线单文件 exe、
生成段并发 2 无外发风险、`config.json` 是配置唯一持久化通道、迁移机制版本化（v1–v4 已用）。

## Goals / Non-Goals

**Goals:**

- 生成段按「规则 → LLM 兜底（可开关）→ 内置兜底技能」为每个任务选定唯一技能，来源留痕
- 技能 = 可配置的「匹配规则 + 专属模板 + 静态知识块 + 审核模式」，随配置持久化、零迁移升级
- 任务表留痕技能维度（快照），为 R4 语料分层统计打底
- 安全闸行为零变化（不变量级验收项）

**Non-Goals:**

- 向量检索/RAG、每技能独立模型与采样参数、自动 prompt 优化、技能级安全闸差异、
  图片/文件消息路由、一 job 多技能、system/user 消息分离（见设计文档 §12/§13 扩展点）

## Decisions

| # | 决策 | 备选与否决理由 |
| --- | --- | --- |
| D1 | 分类在**生成段内部**（渲染提示词前），不在建 job 时 | 建 job 时分类需新增状态列且与崩溃恢复重投/S5 合并语义纠缠；生成段无外发风险、可重试、能按合并后上下文分类 |
| D2 | 分类机制 = 规则优先 + LLM 兜底 + fallback 终兜底（用户已确认） | 纯规则覆盖不了未登记说法；纯 LLM 每次回复两次调用、时延与成本翻倍 |
| D3 | 技能存 `WelinkAgentSettings.skills`（config.json），**不建 SQLite 技能表**（用户已确认） | 建表（welink_group_templates 先例）适合大量实体与独立备份；个人应用技能量少，随设置导入导出更简单；job 侧只存快照无外键 |
| D4 | 兜底技能**不落 skills 数组**：`promptTemplate` 字段语义收窄为兜底模板，运行时清单 = 兜底 + skills | 兜底进数组需防删逻辑与迁移；本方案老配置零迁移、现有「提示词模板」编辑区原地更名即可 |
| D5 | migration v5 给 `welink_reply_jobs` 加 `skill_id/skill_name/skill_source` 三列；`skill_name` 为**快照** | 引用技能表才有外键一致性诉求，本方案无技能表，快照对齐建群模板「历史不变脸」思路 |
| D6 | LLM 分类复用 `agent.complete` + `promptOwners` 按 prompt 精确匹配归属 | 新增端口方法（如 `classify`）会让 mock/HTTP/探测三处连改；既有 onCall→agent_logs 通道自动覆盖分类调用留痕 |
| D7 | `reviewMode='manual'` 转审时序：`commitDraft` 之后、入外发队列之前 `holdJob(pk,'skill_review')`，**不入外发队列** | 与 S7 blacklist 的 hold 语义对齐（停在 ready+hold_reason、待审聚合、不自动外发）；生成中拦截会违反「草稿先落库」铁律 |
| D8 | 知识块是用户自配的**可信文本**（不消毒、只进 prompt、永不作为正文外发）；会话内容消毒规则不变 | 对会话内容消毒会破坏知识格式；对知识块消毒无必要（攻击面 = 用户自己）；外发正文恒为模型输出且过 S6/S7 |
| D9 | **安全闸零改动**：`check()` 签名、判定次序、配额语义全部不变 | 技能维度进 Gate 会造成「某技能配额放宽」这类滥发口子，违反唯一外发出口原则 |

## Risks / Trade-offs

- [LLM 分类增加时延] → 分类 prompt 极短（技能清单+单条消息，秒级）；规则优先把多数请求挡在
  LLM 之前；`llmClassifyFallback` 开关可整体关闭
- [LLM 分类返回不稳定/不合规] → 严格解析（trim 全等 → 首个合法 id → 失败 null）；
  失败即兜底 fallback 不重试不阻断；失败样本经 onCall 落 `welink_agent_logs` 可回溯
- [关键词误命中导致路由错误] → 配置顺序即优先级（可排序）；来源留痕可审计；
  走错技能的后果被兜底模板人设与 S6/S7 限制在「答得不够专业」，不是安全问题
- [技能模板缺失占位符] → 校验层告警不强制改写；`renderPrompt` 单遍替换本身安全；
  `sanitizeReply` 对所有生成路径生效
- [migration v5 升级/回滚] → `ALTER TABLE ADD COLUMN DEFAULT ''` 幂等；老数据空串在展示层
  按「—」处理；回滚后新列残留不影响旧逻辑读取
- [`promptTemplate` 语义收窄触碰双卡透传] → 维持 LlmSettingsCard 单编辑器原则，
  SettingsCard 对 agent 块透传回填的既有契约测试护住回归

## Migration Plan

1. 类型与归一化先行（老配置缺 `skills`/`llmClassifyFallback` → 出厂默认，行为与升级前一致）；
2. migration v5 加三列（幂等 ALTER，两套仓储与契约测试同步）；
3. skill-router 模块 + 管线接入（分类失败路径必须先于成功路径测试）；
4. UI 技能编辑区与 job 徽标；mock 演示剧本扩展（可选，随后单独提交）。
回滚策略：功能全部由配置与代码开关收敛——关闭 `llmClassifyFallback` 且清空 skills 即回到
升级前行为；v5 列只增不改不删。

## Open Questions

无。分类机制、技能存储、产出物形式均已与需求方确认；余下为实施期局部选择
（如 skill 三列与 draft 并入同条 UPDATE 的具体仓储方法签名），不影响规格与任务分解。
