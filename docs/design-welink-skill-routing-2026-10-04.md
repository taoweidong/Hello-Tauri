# WeLink 自动回复「问题分类 + 技能路由」— 方案设计

- 日期：2026-10-04
- 状态：**方案设计（已评审定向，未实施）**；实施任务见 OpenSpec 变更
  `openspec/changes/add-welink-skill-routing/`
- 关联：`docs/design-welink-agent-2026-09-27.md`（总设计 §5B 管线 / §6.2 生成段 / §5A 安全闸）、
  `docs/design-llm-connection-2026-10-02.md`（LLM 连接层，OpenAI 兼容协议已于 2026-10-04 核实对接）、
  `openspec/specs/welink-auto-reply/spec.md`（自动回复安全合同主规格）

---

## 1. 需求与解读

原话：「通过 WeLink CLI 自动获取咨询的相关信息，然后调用不同的 Skill 技能将相关的信息
发送给 LLM 大模型接口，大模型通过分析将回复的信息拼装好后，自动通过 WeLink-CLI 消息发送
机制发送给用户，实现完整的消息自动回复机制。……核心点在于区分用户咨询的问题类型，
可设置不同的 skill 技能。」

口语需求 → 现状映射：

| 口语说法 | 现状 | 结论 |
| --- | --- | --- |
| WeLink CLI 自动获取咨询信息 | 轮询器 `poller.ts` → `pull`（增量游标/去重/自发过滤） | ✅ 已有，复用 |
| 调用不同 Skill 把信息发给 LLM | **不存在**：全局唯一 `promptTemplate`，所有问题一个模板 | ★ 本次核心新增：技能路由 |
| LLM 分析并拼装回复 | `agent.complete(prompt)` 生成段已有（阿里云 MaaS 已对接） | ✅ 复用，模板按技能切换 |
| 自动通过 WeLink-CLI 发送 | 外发段（SafetyGate 十六道闸 → `send` 防双发）已有 | ✅ 复用，不动 |
| 区分用户咨询的问题类型 | **不存在**：`trigger_type`（群@我/私聊/手动）只是场景维度，不参与内容分流 | ★ 新增分类层 |

结论：外发闭环已经完整且被测试钉住，本次只动**生成段的入口**——在「拉上下文」与
「渲染提示词」之间插入「分类 → 选技能」，并把单一全局模板扩展为「兜底技能 + 用户自定义
技能清单」。轮询、触发、安全闸、外发、留痕五条既有链路零改动。

## 2. 现状盘点（本次之前已具备）

| 能力 | 位置 | 状态 |
| --- | --- | --- |
| 轮询取增量（分级调度/续批/去重/自发过滤） | `src/orchestrator/poller.ts` | ✅ 复用 |
| 触发建 job（群@我/私聊/手动 + S5 同人短窗合并） | `src/orchestrator/triggers.ts` | ✅ 复用 |
| 生成段（并发 2：上下文 → renderPrompt → complete → sanitize → commitDraft 原子落库） | `src/orchestrator/pipeline.ts:164` `generateOne` | ★ 接入点 |
| 提示词渲染（4 占位符单遍替换防注入 + 不可信消毒） | `src/infra/agent/prompt.ts` | ★ 扩展 `{{knowledge}}` |
| Agent 端口（prompt-in/result-out + onCall 留痕钩子） | `src/infra/agent/port.ts` | ✅ 复用 |
| HTTP 适配器（OpenAI 兼容，[LLM-ASSUME] 已核实关闭） | `src/infra/agent/agent-http.ts` | ✅ 复用 |
| 安全闸（L0–L3 + S1–S8 十六道闸，唯一外发出口） | `src/orchestrator/safety-gate.ts` | ✅ 不动（不变量） |
| R4 留痕（`welink_agent_logs` 1:N + 👍/👎 评价） | pipeline onCall → repo | ✅ 复用（增技能维度） |
| Agent 设置卡（连接/模板/连通性测试，`weLink.agent` 唯一编辑器） | `src/components/welink/LlmSettingsCard.vue` | ★ 扩展技能编辑区 |

## 3. 缺口分析（本次要补的）

1. **无问题分类**：消息表、任务表、日志表均无 category/intent 列；全链路无分类逻辑。
2. **无技能路由**：所有 job 共用 `settings.agent.promptTemplate` 一个模板，无法按问题类型
   （故障咨询 / 进度查询 / 资料索取 / 制度问答……）定制人设、规则与口径。
3. **无知识注入**：prompt 只含会话上下文，模型只能靠通用能力作答；S7 黑名单只能兜住
   「承诺性/资金类」幻觉输出，治标不治本。
4. **R4 语料缺维度**：👍/👎 评价无法按问题类型聚合，模板调优缺少分层依据。
5. （评估项，本期不做）system/user 消息未分离、采样参数（temperature 等）不可配 —— 见 §10。

## 4. 方案总览

生成段数据流（★ 为本次新增/改造）：

```
discussing → 拉上下文（recentContext，不变）
  → ★ routeSkill 分类：规则命中 → LLM 兜底（可开关）→ fallback 兜底
  → ★ renderPrompt（选中技能的模板 + {{knowledge}} 知识块）
  → agent.complete → onCall 落 agent_logs（不变）
  → sanitizeReply → commitDraft（draft 与 ready 同条 UPDATE，铁律不变）
  → ★ reviewMode='manual' 的技能 → holdJob(pk,'skill_review') 转人工待审（不入外发队列）
  → 外发段（SafetyGate 判定 → send，十六道闸一视同仁，不变）
```

## 5. 决策记录

| 决策 | 选择 | 理由 |
| --- | --- | --- |
| S-A | 分类机制 = **规则优先 + LLM 兜底 + fallback 终兜底**（用户已确认） | 规则命中零延迟零成本且确定；LLM 补关键词覆盖不到的长尾；兜底保证任何情况都有回复路径 |
| S-B | 技能配置存 `config.json`（`WelinkAgentSettings.skills`），**不建 SQLite 技能表**（用户已确认） | 个人应用技能量少（几个~十几个）；随设置导入导出备份；job 只存 ID+名称快照，无外键 |
| S-C | 分类发生在**生成段内部**（`generateOne` 渲染前），不在建 job 时 | 生成段无外发风险、可重试；S5 合并后的 job 按合并上下文分类更准；崩溃恢复重投自动重分类，不引入新状态 |
| S-D | `welink_reply_jobs` 加 `skill_id/skill_name/skill_source` 三列（migration v5），无外键 | 留痕 + 按技能统计；`skill_name` 是**快照**，技能删改后历史不变脸（对齐建群模板快照思路） |
| S-E | 内置**不可删除的兜底技能**（通用助手），其模板即现有 `promptTemplate` 字段 | 老配置零迁移升级；未命中任何技能时行为与今日完全一致（回归风险最小） |
| S-F | **安全闸不感知技能**（安全不变量） | 技能只影响「生成什么」，绝不影响「能不能发」；S1–S8 对所有草稿一视同仁；唯一外发出口不变 |
| S-G | `reviewMode:'manual'` 技能 → 生成后 `holdJob(pk,'skill_review')` 转审 | 高风险问题类型（涉及资金/制度口径）可强制人工把关；复用 O7 待审聚合与 `sendNow` 人工放行通道 |
| S-H | LLM 分类复用 `agent.complete` + `promptOwners` 按 prompt 精确匹配归属 | 不新增端口方法；分类调用自动落 `agent_logs`（1:N 的 seq 已支持一个 job 多次调用），失败样本也可回溯 |
| S-I | 知识注入 = 技能级静态知识块（`{{knowledge}}`），**不做向量检索/RAG** | 单文件离线 exe、内网场景；知识量小、维护者就是用户本人；检索基建成本与收益不成比例 |
| S-J | system/user 分离与采样参数列为扩展点，本期不做 | 阿里云协议已按「单条 user 消息」核实成立，动 `buildRequestParts` 有回归风险，等真实需求再立变更 |

## 6. 技能模型（`src/types/welink.ts`）

```ts
/** 技能命中来源（welink_reply_jobs.skill_source，空串 = 老数据/未分类） */
export type SkillSource = 'rule' | 'llm' | 'fallback'
/** 技能草稿处置：auto = 正常走安全闸；manual = 生成后转人工待审 */
export type SkillReviewMode = 'auto' | 'manual'

export interface WelinkSkill {
  /** 稳定 ID（slug，归一化去重；LLM 分类返回值与 job 留痕都用它） */
  id: string
  /** 显示名，如「故障咨询」 */
  name: string
  /** 技能说明：LLM 分类时模型选择技能的唯一依据，必须写清「什么问题该选它」 */
  description: string
  enabled: boolean
  /** 规则匹配词条：普通文本 = 包含匹配；`/…/` 形式 = 正则（非法正则跳过并 warn） */
  keywords: string[]
  /** 技能专属模板：支持既有 4 占位符 + {{knowledge}}；空 = 回退兜底模板 */
  promptTemplate: string
  /** 静态知识块（FAQ/产品口径），渲染时注入 {{knowledge}}；空 = 占位符替换为空串 */
  knowledge: string
  reviewMode: SkillReviewMode
}
```

`WelinkAgentSettings` 扩展两个字段：

- `skills: WelinkSkill[]` —— 用户自定义技能清单（**不含**兜底技能）；
- `llmClassifyFallback: boolean` —— 规则未命中时是否允许 LLM 分类（默认 `true`）。

**兜底技能不落 skills 数组**：运行时技能清单 = `[兜底技能(promptTemplate), ...skills]`。
`promptTemplate` 字段语义收窄为「兜底技能模板」，老配置升级零迁移（S-E）；
设置页现有「提示词模板」编辑区相应更名「兜底技能（通用助手）」。

归一化（`normalizeWelinkSettings` 收敛，全部纯函数便于单测）：

- skills 非数组 → 出厂空数组；条数截到 **≤ 20**（防手改 config.json 灌爆）；
- `id`：trim、slug 化（小写字母数字连字符）、数组内去重（撞车追加 `-2` 序号）、空 id 派生 `skill-<序号>`；
- `keywords`：字符串数组清洗（trim、去空）；`reviewMode` 非 `'manual'` → `'auto'`；
- `promptTemplate` 为空 → 回退兜底模板；缺 `{{question}}` 占位符**不强制改写**，
  与现有 `promptTemplate` 的处理一致（校验层提示，运行期 `renderPrompt` 单遍替换本身安全）。

## 7. 分类器设计（新模块 `src/orchestrator/skill-router.ts`）

```ts
export interface SkillDecision {
  skill: WelinkSkill
  source: SkillSource
}

/** 唯一入口：规则 → LLM 兜底（可开关）→ fallback。任何分支都不 reject，保证主链路不断 */
export async function routeSkill(input: {
  question: string
  context: WelinkMessage[]
  candidates: WelinkSkill[]   // enabled 的技能清单（含兜底技能，供 LLM 选择的完整清单）
  fallback: WelinkSkill
  llmClassify: boolean
  agent: AgentClient
}): Promise<SkillDecision>
```

纯函数三件套（单独可测）：

- `matchSkillByRules(question, contextText, skills)`：按 skills 数组**配置顺序**取首个命中者
  （先配置先匹配，简单可预期；UI 支持排序）；词条匹配作用域 = 触发消息内容 + 最近上下文
  拼接文本（不区分大小写的包含匹配）；`/…/` 形式按正则匹配，`new RegExp` 抛错则跳过该词条并 warn；
  启用关键词的**兜底技能本身不参与规则匹配**（它就是「没匹配上」的归宿）。
- `buildClassifyPrompt(candidates, question)`：分类 prompt 形状固定（可读、可留痕、可调优）：

  ```
  你是消息分类器。根据技能清单，为「需要回复的消息」选择唯一合适的技能。
  只输出该技能的 id，不要输出任何其他文字。

  可用技能：
  - id: fault-troubleshooting  名称：故障咨询  说明：……
  - id: progress-inquiry       名称：进度查询  说明：……
  - id: fallback               名称：通用助手  说明：……

  【需要回复的消息】
  ……
  ```

- `parseClassifyReply(reply, candidates)`：**严格解析** —— 返回文本 trim 后全等某个候选 id，
  否则在文本中查找首个出现的合法 id；找不到 → null（调用方兜底）。

兜底语义：LLM 分类**失败**（超时/报错/解析不出）或**开关关闭** → 直接 `fallback`
（`source='fallback'`；`source` 表达的是「最终生效来源」，失败细节已由 onCall 落
`agent_logs` 可回溯，不在 job 上重复记错误字段）。

**重试语义**：生成失败重试会重新走 `generateOne`，即重新分类 —— 规则分类是确定性的
（同输入同结果）；LLM 分类理论上可能变化，但概率低且两个来源都合法，**不引入额外状态**
去冻结首次决策（KISS）。

## 8. 管线接入（`generateOne` 改造点）

位置：`src/orchestrator/pipeline.ts:164` `generateOne`，拉完上下文之后、`renderPrompt` 之前。

1. 组装候选清单：`enabled` 的 `settings.agent.skills` + 兜底技能（模板取 `settings.agent.promptTemplate`）。
2. `routeSkill(...)` 得到 `SkillDecision`；规则未命中且 `llmClassifyFallback` 开启时多一次
   LLM 调用 —— 分类 prompt 极短（技能清单 + 一条消息），自动回复场景时延优先模型
   （qwen3.8-flash）实测在秒级，生成段并发 2 的吞吐不受实质影响。
3. `promptOwners` 槽位机制**天然支持**：分类调用与生成调用各登记一个槽（按 prompt 精确
   匹配归属，两类 prompt 形状不同不会串台）；两次调用各落一条 `agent_logs`（seq 递增）。
4. `renderPrompt` 改用**选中技能**的模板；模板含 `{{knowledge}}` 时注入技能知识块
   （知识块是用户自配的可信文本，不走 `sanitizeUntrusted`；会话内容照旧消毒）。
5. `commitDraft(jobPk, cleaned, prompt)` 的 `prompt` 参数 = **最终生成 prompt**
   （分类 prompt 只存在于 `agent_logs`，不进 job 的 `context_snapshot` 语义）。
6. **reviewMode='manual' 的转审时序**（与 S7 blacklist 语义对齐）：
   `commitDraft` 成功后、`sendQueue.push` 之前 —— `holdJob(pk, 'skill_review')` →
   **不入外发队列** → `emitStatus(ready→ready, holdReason='skill_review')`。
   草稿已落库（铁律满足），job 停在「待审」（O7 reviewCount 自动聚合），人工在待审列表
   走既有 `sendNow` 放行（manualOverride 绕 manual 拦截，Gate 其余规则照走）。
   `HoldReason` 枚举增 `'skill_review'`，`HOLD_REASON_LABEL` 增文案「技能策略待审」。
7. `SkillDecision` 同时回写 job 留痕（见 §9）。

## 9. 数据模型（migration v5）

```sql
ALTER TABLE welink_reply_jobs ADD COLUMN skill_id    TEXT NOT NULL DEFAULT '';
ALTER TABLE welink_reply_jobs ADD COLUMN skill_name  TEXT NOT NULL DEFAULT '';
ALTER TABLE welink_reply_jobs ADD COLUMN skill_source TEXT NOT NULL DEFAULT '';
```

- 生成段分类完成后即回写三列（新增仓储方法或并入 `commitDraft` 同条 UPDATE —— 实施时
  按「draft + ready + skill 三列一条 UPDATE」落地，保持单条原子写的既有风格）；
- `skill_name` 是**快照**：技能后续改名/删除，历史 job 展示不变脸；
- `skill_source ∈ rule|llm|fallback|''`（空串 = 老数据，展示层按「—」处理）；
- `WelinkJob` 类型 +3 字段（`skillId/skillName/skillSource`）；SQLite 仓储
  （`src/infra/db/repos/welink.ts`）与内存仓储（`welink-memory.ts`）同步列映射，
  共享契约测试（`welink-contract.spec.ts`）补用例；
- 迁移编号衔接既有序列：v1 records / v2 welink / v3 group / v4 codehub → **v5 = 本变更**。

## 10. UI 设计

**`LlmSettingsCard.vue`**（`weLink.agent` 唯一编辑器，维持单编辑器原则）新增「回复技能」折叠区：

- `llmClassifyFallback` 开关 + 说明文案（「规则未命中时让模型选技能，每次回复多一次调用」）；
- 技能列表（卡片行）：名称 / 启停 switch / 关键词数 / 「需人工审核」标签 / 编辑 / 删除；
  空列表显示引导文案（「未配置技能时全部消息走兜底模板」）；
- 技能编辑器（行内展开或对话框）：名称（必填）、说明（textarea，提示「LLM 分类的选择依据」）、
  关键词（el-tag 动态增删，`/…/` 正则提示，非法正则即时红字）、模板 textarea
  （复用占位符点击插入 + 缺失占位符告警）、知识块 textarea、reviewMode switch；
- 现有「提示词模板」折叠区更名「兜底技能（通用助手）」，编辑逻辑不变，另加知识块输入
  （兜底技能同样支持知识注入）；
- 校验：名称必填、模板缺失 `{{question}}` 告警（复用 `missingPlaceholders`）。

**回复历史 job 卡片**：状态徽标旁显示技能名 tag（`job.skillName` 非空才渲染；
`skill_source` 映射规则/模型/兜底小字或 tooltip）。

## 11. 安全不变量（本期写死，评审对照项）

1. **安全闸不感知技能**：`SafetyGate.check()` 签名与判定顺序（L0→L1→L2→L3→S8→S4→S6→S7→
   S1→S5→S2→S3）不变；技能维度不参与任何 Gate 判定；S1–S8 对所有技能生成的草稿一视同仁。
2. **唯一外发出口不变**：技能路由发生在生成段（无外发风险段），外发段仍是 Gate 唯一出口；
   `reviewMode='manual'` 的转审发生在 `commitDraft` 之后、入外发队列之前 —— 与「草稿先落库
   置 ready 才允许外发」铁律兼容（草稿已落库，转审只是不让它进自动外发队列）。
3. **黑名单优先**：S7 命中转审（hold_reason='blacklist'）不受技能配置影响；`skill_review`
   与 `blacklist` 同时命中时，Gate 判定先行（sendOne 里），生成段的 skill_review hold
   已让 job 停在待审，两者语义叠加不冲突（都在待审聚合里，人工放行都要过 Gate）。
4. **提示词注入防御不放松**：会话内容仍走 `sanitizeUntrusted`（剥控制字符/拍平换行/截断）；
   技能关键词与知识块是用户自配的可信文本，不消毒但**永不自动外发原文**（只进 prompt）。
5. **急停/熔断照旧**：L0 急停与 S8 熔断对分类与生成路径同样生效（分类在生成段，急停停
   worker 即停分类；熔断停外发与技能无关）。

## 12. 明确不做（非目标）

- 向量检索 / RAG / 知识库管理页 —— 静态知识块覆盖个人场景（S-I）；
- 每技能独立 model / temperature / baseUrl —— `agentClient` 工厂是单例缓存（键含
  model 等），多客户端池是另一个量级的改造，等真实需求；
- 自动 prompt 优化 / 微调闭环 —— 总设计 §2 既有非目标，本期不翻案；
- 技能级安全闸差异（某技能配额放宽等）—— 违反 S-F 不变量；
- 图片/文件消息的技能路由 —— 非 text 消息仅占位存档不触发（既有规则）；
- 一个 job 命中多个技能的叠加路由 —— 一 job 一技能，多技能诉求靠关键词排序表达优先级。

## 13. 扩展点（本期预留，不实现）

1. **system/user 消息分离**：`buildRequestParts` 增可选 system 消息（技能模板首段作
   system）—— LLM 连接文档 §7 第 4 条预留项，触发条件 = 真实服务端提出要求；
2. **按技能维度的质量统计**：`skill_id` 落库后，R4 语料导出（Q6）与回复历史筛选天然支持
   「每技能采纳率/差评率」，UI 后续可加技能筛选器；
3. **mock 演示剧本扩展**：`mock.ts` 的关键词回复（报500/进度/文档/会议）已是技能路由雏形，
   实施时同步让演示剧本覆盖多类型问题，浏览器调试可见路由效果（配 `welink_agent_logs`
   观察分类调用留痕）；
4. **关键词库沉淀**：从 R4 差评语料人工反补技能关键词（不做自动挖掘）。

## 14. 测试与验证计划

| 测试 | 覆盖 |
| --- | --- |
| `src/types/welink.spec.ts` | skills 归一化收敛（截断/去重/slug/回退）、`llmClassifyFallback` 兜底、老配置零迁移 |
| `src/orchestrator/skill-router.spec.ts` | 规则命中与配置顺序优先级、正则词条、非法正则跳过、LLM 分类成功/解析失败兜底/开关关闭直兜底、兜底技能不参与规则匹配 |
| `src/orchestrator/pipeline.spec.ts` | 分类接入后草稿生成主链路、reviewMode='manual' 转审不入外发队列、job 三列留痕、分类调用落 agent_logs |
| `src/infra/db/**`（迁移 + 契约测试） | v5 列映射、老数据空串兼容、两套仓储一致 |
| `src/components/welink/LlmSettingsCard.spec.ts` | 技能编辑区契约（增删改、防顶回、归一化透传） |
| 覆盖率基线 | `orchestrator/**` 92% lines、`infra/db/**` 72% lines 不回退 |

## 15. 实施清单（对应 OpenSpec tasks 分解）

| 文件 | 改动 |
| --- | --- |
| `src/types/welink.ts` | `WelinkSkill/SkillSource/SkillReviewMode` 类型；`WelinkAgentSettings.skills/llmClassifyFallback`；默认值与 `normalizeWelinkSettings` 收敛；`HoldReason` + `'skill_review'` |
| `src/orchestrator/skill-router.ts` | 新模块：`routeSkill` + 规则匹配/分类 prompt/解析三件套 |
| `src/orchestrator/pipeline.ts` | `generateOne` 接入分类与技能模板；reviewMode 转审时序 |
| `src/infra/agent/prompt.ts` | `renderPrompt` 支持 `{{knowledge}}`；`PROMPT_PLACEHOLDERS` 扩充 |
| `src/infra/db/migrations/` | v5：`welink_reply_jobs` 三列 |
| `src/infra/db/ports.ts` + `repos/welink.ts` + `welink-memory.ts` | `WelinkJob` 三字段映射与回写通道 |
| `src/components/welink/LlmSettingsCard.vue` | 「回复技能」编辑区 + 兜底技能区更名 |
| 回复历史组件 | job 卡片技能徽标 |
| `src/infra/agent/mock.ts` | 演示剧本覆盖多类型问题（扩展点 3，可与主链路同批或随后） |
| `openspec/specs/welink-auto-reply/spec.md` | 经 delta 归档同步新增需求段 |
