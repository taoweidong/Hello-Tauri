# Tasks

## 1. 类型与配置层

- [x] 1.1 `src/types/welink.ts` 新增 `WelinkSkill`/`SkillSource`/`SkillReviewMode` 类型；`WelinkAgentSettings` 增加 `skills`/`llmClassifyFallback`；`HoldReason` 增 `'skill_review'` 并补 `HOLD_REASON_LABEL` 文案「技能策略待审」。验证：`npm run typecheck` 通过
- [x] 1.2 `DEFAULT_WELINK_SETTINGS` 补默认值；`normalizeWelinkSettings` 收敛 skills（≤20 截断、id slug 化与去重、keywords 清洗、reviewMode 非 manual 收敛 auto、模板空回退兜底模板）与 `llmClassifyFallback` 布尔兜底。验证：`src/types/welink.spec.ts` 新增用例（老配置零迁移、超限截断、id 去重、非法枚举收敛）全绿

## 2. 数据模型（migration v5）

- [x] 2.1 新增 migration v5：`welink_reply_jobs` 增加 `skill_id`/`skill_name`/`skill_source` 三列（TEXT NOT NULL DEFAULT ''）。验证：迁移用例（幂等重放、老库升级后列存在且默认空串）通过
- [x] 2.2 `src/infra/db/ports.ts` 的 `WelinkJob` 增 `skillId`/`skillName`/`skillSource`；`repos/welink.ts` 列映射并使草稿提交以「draft + ready + skill 三列」同条 UPDATE 回写；`welink-memory.ts` 同步契约。验证：`welink-contract.spec.ts` 两套仓储一致性用例通过

## 3. 分类器模块

- [x] 3.1 新增 `src/orchestrator/skill-router.ts` 纯函数三件套：`matchSkillByRules`（按配置顺序取首个命中、包含匹配不区分大小写、`/…/` 正则、非法正则跳过并 warn）、`buildClassifyPrompt`（技能清单 id/名称/说明 + 待分类消息的固定形状）、`parseClassifyReply`（trim 全等 → 首个合法 id → null）。验证：`skill-router.spec.ts` 纯函数用例全绿
- [x] 3.2 `routeSkill` 异步入口：规则 → LLM 兜底（受开关控制，复用 `AgentClient.complete`）→ fallback，任何分支不 reject。验证：`skill-router.spec.ts` 覆盖 LLM 命中、解析失败兜底、超时/报错兜底、开关关闭直兜底、兜底技能不参与规则匹配

## 4. 提示词层

- [x] 4.1 `src/infra/agent/prompt.ts`：`PROMPT_PLACEHOLDERS` 扩充 `{{knowledge}}`；`renderPrompt` 注入技能知识块（可信配置文本不消毒，永不作为正文外发），会话内容的 `sanitizeUntrusted` 路径不变。验证：`prompt.spec.ts` 新增知识块注入与消毒不变用例全绿

## 5. 管线接入

- [x] 5.1 `src/orchestrator/pipeline.ts` `generateOne`：拉上下文后插 `routeSkill`，按命中技能模板渲染（含知识块）；为分类调用登记 `promptOwners` 槽位；技能三列随 `commitDraft` 同条 UPDATE 留痕。验证：`pipeline.spec.ts` 覆盖模板切换、三列留痕、分类与生成两条 agent_logs 记录
- [x] 5.2 `reviewMode='manual'` 转审时序：`commitDraft` 成功后、入外发队列前 `holdJob(pk,'skill_review')` 且不入外发队列；人工 `sendNow` 放行走既有通道且安全闸其余规则照走。验证：`pipeline.spec.ts` 覆盖转审不入队、待审计数聚合、人工放行回归用例

## 6. UI

- [x] 6.1 `LlmSettingsCard.vue` 新增「回复技能」折叠区：`llmClassifyFallback` 开关、技能列表增删改与启停、技能编辑器（名称/说明/关键词 tag/模板占位符插入/知识块/审核开关）、名称必填与缺失占位符告警；「提示词模板」区更名「兜底技能（通用助手）」并加知识块输入。验证：`LlmSettingsCard.spec.ts` 契约用例（增删改、防抖透传、双卡防顶回）全绿
- [x] 6.2 回复历史 job 卡片显示技能徽标（`skillName` 非空才渲染，来源 rule/llm/fallback 作 tooltip）。验证：组件 spec 断言渲染条件与老数据空串不渲染

## 7. 集成验证

- [x] 7.1 （可选）`src/infra/agent/mock.ts` 演示剧本扩展多类型问题样本，浏览器调试可观察技能路由与分类调用留痕。验证：mock 剧本 spec 通过，`npm run dev` 手工演示走查
- [x] 7.2 收尾门禁：`npm run check`（lint + typecheck + test）全绿；`npm run test:coverage` 核对 `orchestrator/**` ≥92%、`infra/db/**` ≥72% lines 基线不回退
