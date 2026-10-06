# Design

> 完整方案（现状盘点、决策 D-A~D-J、[RAG-ASSUME] 假设清单、SOP、UI 要点、测试计划）已定稿于
> `docs/design-welink-rag-retrieval-2026-10-05.md`，本文为实施视角的决策提炼，两者不一致时
> 以本文为准（本文为后定稿的评审产物）。

## Context

生成段现为：`routeSkill 技能路由 → renderPrompt（4+1 占位符）→ agent.complete → sanitizeReply
→ commitDraft(draft+ready+skill 原子落库)`。知识供给只有技能级静态 `{{knowledge}}`。基础设施
事实：`http_post_json` 宿主通道（LLM 同款，可选 transport 注入模式成熟）；`fsRead/fsWrite`
数据根内安全文件通道（写自动建父目录、无列目录、无删除）；rusqlite bundled；web 模式文件
通道诚实抛错。约束：内网离线单文件 exe、零 Rust 偏好、零迁移承诺、安全闸唯一外发出口不变。

## Goals / Non-Goals

**Goals:**

- 按技能检索外挂 RAG 服务，命中片段注入 `{{retrieved}}`，回复「有据可依」
- `knowledge/*.md` + `index.json` 的本地知识库管理（CRUD/登记/下架，零 Rust）
- 检索失败静默降级，主链路与安全闸零影响；老配置零迁移

**Non-Goals:**

- 本地向量库/嵌入/FTS5 兜底、检索统计（零迁移，列扩展点）；推送 md 建索引；md 物理删除与
  版本管理；query 改写与多轮检索；安全闸改动

## Decisions

| # | 决策 | 备选与否决理由 |
| --- | --- | --- |
| D1 | 新模块 `infra/rag/`，不复用 `infra/agent` | 检索与模型调用是不同外部依赖（配置/故障特征/语义都不同）；但**复用其全部模式**：端口-适配器、transport 注入、IP 守卫、mock 先行 |
| D2 | 检索位置 = routeSkill 之后、renderPrompt 之前（生成段内） | 需要技能的 retrieval 绑定（filter/开关）决定是否检索与怎么检；生成段无外发风险、失败可降级；放建 job 时会丢失技能决策 |
| D3 | 新占位符 `{{retrieved}}`，不复用 `{{knowledge}}` | 「人维护的静态口径」vs「机器取回的事实」语义分离；旧模板零变化；模板作者自行决定两者位置 |
| D4 | 检索失败 = 空串 + warn，不重试不进 agent_logs | 检索是增强不是依赖；重试会放大延迟且检索失败时生成本可继续；agent_logs 语义是模型调用语料，混入检索错误污染 R4 分析 |
| D5 | 拼装格式 `【知识N】(来源, 相关度) + 正文`，整体可信不消毒但受 `maxChars` 截断 | 对齐 D8（知识库是企业内部可信文本）；结构头由本端生成防伪造；截断防 prompt 爆量 |
| D6 | 知识库清单 = `knowledge/index.json`，应用内 CRUD + 登记制，删除 = 下架 | 加 `fs_list`/`fs_delete` 各要多一个 Rust 命令、本期收益低；下架保留数据（md 不丢），登记即对账 |
| D7 | 检索调用留痕：结果随生成 prompt 进 agent_logs，检索本身不建表 | 零迁移；「检索到了什么」看 prompt 全文即可回溯；独立 rag_logs 等真实运维需求再立变更 |
| D8 | 兜底技能检索由 `rag.fallbackRetrieve` 全局开关控制 | 兜底技能不是 skills 数组成员（D4 既有决策），无处挂技能级字段；全局开关语义清晰 |

## Risks / Trade-offs

- [RAG 服务不可用/慢] → 静默降级到无检索水平；`timeoutMs` 上限 60s 且默认 10s；生成段并发 2
  不会因检索互相阻塞
- [检索内容质量差导致错误回复] → `minScore` 阈值过滤 + 模板约束（建议配「知识库没有的不要
  编造」）+ R4 语料 👍/👎 按 skill 维度观察；manual 模式人工把关可先跑
- [知识库内容过期/与 RAG 索引不一致] → md 是知识源但索引由服务方维护，应用无法感知过期 ——
  「变更指纹提醒」列扩展点，本期在知识库卡文案提示「更新文档后请在 RAG 服务侧同步索引」
- [filter 语义未定] → [RAG-ASSUME] 假设自由字符串透传，格式对接时核实；不启用检索的技能完全
  不受影响
- [index.json 与实际文件漂移] → 登记制 + 「文件已被移走」可行动提示；漂移的代价是有意识的
  （下架/登记），不是静默
- [双卡/三卡并存互踩] → rag 块唯一编辑器 RagSettingsCard + SettingsView 直接挂载（agent 块
  双卡透传的教训已消化为单编辑器原则）

## Migration Plan

1. 类型与归一化先行（rag 块/skill.retrieval 缺省 → 检索关闭，行为与升级前一致）；
2. infra/rag 四件套 + prompt 占位符（mock 可独立演示）；
3. 管线接入（降级路径先于命中路径测试）；
4. UI 三处（RAG 卡/知识库卡/技能检索区）；
5. 集成验证 + GUI 走查。
回滚：清空 rag 配置或关闭全部技能检索即回升级前行为；零迁移无数据回滚问题。

## Open Questions

无。索引关系、作用域、管理形态、数据库角色四分叉已与需求方确认（2026-10-05）；
[RAG-ASSUME] 端点形状待真实服务文档到位后按 SOP 核实，不影响本提案的任务分解。
