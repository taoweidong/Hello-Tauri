# Tasks

## 1. 类型与配置层

- [x] 1.1 `src/types/welink.ts` 新增 `RagSource`/`WelinkRagSettings`；`WelinkSettings` 增 `rag` 块；`WelinkSkill` 增 `retrieval: { enabled, filter? }`。验证：`npm run typecheck` 通过
- [x] 1.2 `DEFAULT_WELINK_SETTINGS.rag` 出厂默认；`normalizeWelinkSettings` 收敛 rag 块（ragSource 枚举、baseUrl http(s) 校验、timeoutMs 1000–60000、topK 1–10、minScore 0–1、maxChars 200–4000、apiKey trim、fallbackRetrieve 布尔）与 skill.retrieval（缺省 `{ enabled: false }`）。验证：`src/types/welink.spec.ts` 新增用例（老配置零迁移、越界收敛、非法地址回退）全绿

## 2. infra/rag 端口模块

- [x] 2.1 新增 `src/infra/rag/port.ts`（`RagChunk/RagQuery/RagPort/RagError/RagClient`）与 `mock.ts`（确定性关键词命中 + failNext 故障注入 + 调用记录）。验证：`npx vitest run src/infra/rag` mock 用例全绿
- [x] 2.2 新增 `src/infra/rag/rag-http.ts`：`createHttpRag`（可选 transport 注入；POST `{baseUrl}{endpoint}`、Bearer trim 可选、请求 `{query, top_k, filter?}`；响应候选字段容错解析 results/chunks/hits；`[RAG-ASSUME]` 头注释标注）；`index.ts` 工厂（缓存键、浏览器强制 mock、baseUrl 空回退 mock、公网 literal IP 守卫）。验证：`ports.spec.ts` 覆盖请求形状/Bearer/解析容错/超时分类/IP 守卫/浏览器 mock 全绿

## 3. 提示词层

- [x] 3.1 `src/infra/agent/prompt.ts`：`PROMPT_PLACEHOLDERS` 增 `{{retrieved}}`；`PromptInput.retrieved?`；渲染注入（可信文本不消毒、空缺省空串）。验证：`prompt.spec.ts` 新增注入/零变化/unknownPlaceholders 用例全绿

## 4. 管线接入

- [x] 4.1 `src/orchestrator/pipeline.ts` `generateOne`：routeSkill 后按 `decision.skill.retrieval.enabled`（兜底技能看 `rag.fallbackRetrieve`）调 `ragClient.retrieve`；命中经 minScore 过滤与 maxChars 截断拼装进 `renderPrompt({ retrieved })`；失败/零命中空串降级（logger.warn，不重试不阻断）。验证：`pipeline.spec.ts` 覆盖命中注入/失败降级/禁用跳过（不发检索）/截断过滤全绿
- [x] 4.2 `runtime.ts` 装配 `ragClient`（对齐 agentInstance 模式）并随 settings 热更新重建。验证：runtime 相关既有用例保持绿

## 5. UI

- [x] 5.1 新增 `src/components/welink/RagSettingsCard.vue`（`weLink.rag` 唯一编辑器：来源/地址/路径/密钥/超时/topK/minScore/maxChars/兜底检索开关/「测试检索」按钮与结果摘要）并挂载 `SettingsView.vue`。验证：组件契约 spec（防抖透传/归一化回填/测试按钮调用 store 探测）全绿
- [x] 5.2 新增 `src/components/welink/KnowledgeCard.vue`（清单/新建/编辑/下架含语义确认文案/登记手动文件/文件丢失提示/web 模式降级提示）并挂载 `SettingsView.vue`；web 模式 `fsRead/fsWrite` 抛错被捕获为降级态。验证：契约 spec（CRUD/登记/下架/降级）全绿
- [x] 5.3 `SkillsSection.vue` 技能编辑器增「知识检索」区块（enabled 开关 + filter 输入 + 说明文案）随草稿保存。验证：SkillsSection spec 补区块用例全绿
- [x] 5.4 `stores/welink` 增 `probeRag`（独立实例探测，不污染任何语料，对齐 probeAgent 模式）。验证：store spec 用例全绿

## 6. 集成验证

- [x] 6.1 收尾门禁：`npm run check`（lint + typecheck + test）全绿；`npm run test:coverage` 核对 `orchestrator/**` ≥92%、`infra/db/**` ≥72% lines 基线不回退
- [x] 6.2 浏览器 GUI 走查：web 模式知识库卡降级提示、技能检索区交互、mock RAG 命中的端到端回复（回放演示剧本 + Agent 回溯可见检索片段）；桌面模式留待真实 RAG 服务按 SOP 核实 [RAG-ASSUME]
