# Proposal

## Why

自动回复的「知识供给」目前只有技能级静态 `{{knowledge}}` 口径块——人工维护、粒度粗、覆盖窄，
问题一旦超出预写口径，模型只能通用作答甚至编造，回复准确性与「应答机器人」的目标有实质差距。
内网已有 RAG 检索服务（外挂 HTTP 接口，知识已索引），本地知识源约定为 Markdown 文档。把
「按问题动态取知识」接进生成段——检索命中片段注入提示词——是提升回复准确性的最短路径，
且不触碰外发闭环与安全闸。

## What Changes

- **新增 RAG 检索端口**：`src/infra/rag/`（port / rag-http / mock / index），检索走既有
  `http_post_json` 宿主通道（与大模型对接同构，零 Rust）；`[RAG-ASSUME]` 假设契约 + mock
  先行，浏览器模式强制 mock；公网 literal IP 守卫对齐 agent-http（S-1 同款）。
- **技能绑定检索**：`WelinkSkill` 增 `retrieval: { enabled, filter? }`（filter = 传给 RAG 的
  过滤条件），生成段在技能路由之后、渲染提示词之前按技能检索；兜底技能由
  `rag.fallbackRetrieve` 控制。老配置零迁移（缺省 = 不检索，行为与升级前一致）。
- **检索事实注入**：新占位符 `{{retrieved}}`（与静态 `{{knowledge}}` 语义分离）；pipeline 拼
  装命中片段（`【知识N】(来源, 相关度)` 头 + 正文，过滤 `minScore`、截断 `maxChars`）；检索
  内容为企业内部知识、可信不消毒（对齐既有 D8 立场），会话内容消毒路径不变。
- **失败静默降级**：检索失败/超时/零命中一律空串、logger.warn、不重试不阻断——检索是增强
  不是依赖。
- **RAG 连接配置**：`WelinkSettings.rag`（ragSource mock|http、baseUrl、endpoint、apiKey、
  timeoutMs、topK、minScore、maxChars、fallbackRetrieve），normalize 三层兜底；设置页新增
  「知识检索（RAG）」卡（含「测试检索」按钮）；零迁移。
- **本地知识库管理**：设置页新增「知识库」卡——`knowledge/*.md` + `knowledge/index.json`
  清单，走既有 `fsRead/fsWrite`（零 Rust）：新建/编辑/**下架**（fs 通道无删文件能力，删除 =
  下架，md 留存数据根）/「登记」手动放入的文件；web 模式文件通道不可用 → 整卡降级提示。
- **留痕**：检索结果注入生成 prompt 后随 R4 语料（`welink_agent_logs`）天然可回溯；检索调用
  不单独建表（零迁移）。

**不做（本期）**：本地向量库/嵌入模型、SQLite FTS5 兜底检索与检索统计（零迁移，列扩展点）、
应用推送 md 建索引、md 物理删除、知识文档版本管理、query 改写与多轮检索、安全闸任何改动。

## Capabilities

### New Capabilities

- `knowledge-base`: 本地 md 知识库管理——清单真源（knowledge/index.json）、新建/编辑/下架
  （下架语义 = 停用不删文件）、手动文件登记、web 模式降级提示；文件通道安全边界沿用
  fsRead/fsWrite（数据根内相对路径）。

### Modified Capabilities

- `welink-auto-reply`: 新增「知识检索增强」需求段——按技能检索（技能绑定开关与过滤条件、
  兜底技能开关）、`{{retrieved}}` 注入与旧模板零变化、失败静默降级不阻断、检索结果随生成
  prompt 留痕可回溯、RAG 连接配置归一化与浏览器强制 mock；既有需求（轮询、草稿先落库、
  安全闸、防双发、技能路由、急停跨重启、演示剧本）全部不变。

## Impact

- **代码（TS 层为主，零 Rust、零迁移）**：
  - 增：`src/infra/rag/**`（port / rag-http / mock / index）、
    `src/components/welink/RagSettingsCard.vue`、`src/components/welink/KnowledgeCard.vue`。
  - 改：`src/types/welink.ts`（rag 配置块/skill.retrieval/normalize）、
    `src/infra/agent/prompt.ts`（{{retrieved}}）、`src/orchestrator/pipeline.ts`（检索注入与
    降级）、`src/components/welink/settings/SkillsSection.vue`（技能检索配置区）、
    `src/views/SettingsView.vue`（挂载两张新卡）。
  - Bridge 与 Rust：零改动。
- **数据**：`config.json` 的 `weLink.rag` 新块（老配置零迁移）；数据根新增 `knowledge/`
  子目录（md + index.json，fsWrite 自动建父目录）；SQLite 零变更。
- **测试**：types/rag 端口/prompt/pipeline/两个新组件各补 spec；`orchestrator/**` 92%、
  `infra/db/**` 72% 覆盖率基线不回退。
- **依赖**：零新增。
- **方案细节与决策记录**：`docs/design-welink-rag-retrieval-2026-10-05.md`（D-A~D-J、
  [RAG-ASSUME]、SOP）。
