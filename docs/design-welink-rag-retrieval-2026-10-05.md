# WeLink 自动回复「RAG 检索增强 + 本地知识库」— 方案设计

- 日期：2026-10-05
- 状态：**方案设计（已评审定向，未实施）**；实施任务见 OpenSpec 变更
  `openspec/changes/add-welink-rag-retrieval/`
- 关联：`docs/design-welink-skill-routing-2026-10-04.md`（技能路由，S-I/D8 决策被本变更自然升级）、
  `docs/design-llm-connection-2026-10-02.md`（HTTP 宿主通道与连接配置惯例）、
  `docs/design-welink-agent-2026-09-27.md`（总设计 §5B 管线 / §5A 安全闸）、
  `openspec/specs/welink-auto-reply/spec.md`、`openspec/specs/data-storage-lifecycle/spec.md`

---

## 1. 需求与解读

原话：「如何使用本地数据库和已有 RAG 服务，提升自动回复的准确性，目标是实现自动回复应答机器人
功能。……RAG 通过外挂 http 接口的方式获取知识，本地知识库使用 md 文档。」

口语需求 → 方案映射：

| 口语说法                              | 方案落点                                                                                                       |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| 已有 RAG 服务，外挂 http 接口获取知识 | 新增 `infra/rag/` 端口-适配器，检索走 `bridge.httpPostJson` 宿主通道（与大模型同构，零 Rust）                  |
| 本地知识库使用 md 文档                | 数据根 `knowledge/*.md` 为知识源；设置页新增「知识库」卡管理（走既有 `fsRead/fsWrite`，自动建父目录，零 Rust） |
| 提升自动回复准确性                    | 生成段按技能检索知识、命中片段注入 `{{retrieved}}`，回复「有据可依」；与技能路由正交组合                       |
| 自动回复应答机器人                    | 不改变外发闭环与安全闸，只升级生成段的「知识供给」                                                             |

需求方已确认四个分叉（2026-10-05）：① RAG 已索引好、应用只查；② 按技能检索 +
`{{retrieved}}` 占位符；③ 知识库应用内 CRUD（零 Rust）；④ 本期零迁移。

## 2. 现状盘点（本次之前已具备）

| 能力                                                                          | 位置                                                  | 状态                                         |
| ----------------------------------------------------------------------------- | ----------------------------------------------------- | -------------------------------------------- |
| 生成段：routeSkill 技能路由 → 按技能模板渲染 → complete → commitDraft         | `src/orchestrator/pipeline.ts`                        | ★ 检索注入接缝                               |
| 静态知识块 `{{knowledge}}`（技能级，可信不消毒）                              | `src/infra/agent/prompt.ts` + `WelinkSkill.knowledge` | ✅ 保留，与检索正交                          |
| HTTP 宿主通道 `http_post_json`（传输层故障才 reject、2MB 截断、超时宿主强制） | `src-tauri/src/http.rs` + Bridge `httpPostJson`       | ✅ RAG 检索复用                              |
| transport 组合点注入模式（桌面宿主通道 / 测试 window.fetch）                  | `src/infra/agent/agent-http.ts` + `index.ts`          | ✅ rag-http 对齐                             |
| 连接配置卡惯例（单编辑器/防抖/双卡透传/三层归一化）                           | `LlmSettingsCard.vue`、`normalizeWelinkSettings`      | ✅ 新卡对齐                                  |
| 文件通道 `fsRead/fsWrite`（数据根内相对路径、拒 `..`、写自动建父目录）        | `src-tauri/src/fs.rs`、Bridge `fsRead/fsWrite`        | ✅ 知识库复用；**缺列目录能力**（见 §5 D-F） |
| web 模式文件通道诚实抛错                                                      | `src/api/web.ts`                                      | ✅ 知识库卡据此降级                          |
| 技能模型 `WelinkSkill`（关键词/模板/知识块/审核）                             | `src/types/welink.ts`                                 | ★ 增检索绑定字段                             |
| 迁移注册表 v1–v5、R4 留痕 `welink_agent_logs` 1:N                             | `src/infra/db/index.ts`、repos                        | ✅ 本期零迁移                                |

## 3. 缺口分析（本次要补的）

1. **知识供给是静态的**：`{{knowledge}}` 是手工维护的固定口径，问题千变、口径千行时既写不全也
   注不起——需要「按问题动态取知识」。
2. **无检索端口**：全库无 RAG/向量/检索相关代码；外挂 RAG 服务的 HTTP 检索没有端口-适配器。
3. **知识库无管理面**：md 文档散落数据根，无清单、无 CRUD、无登记入口。
4. **提示词无检索事实位**：模板只有静态 `{{knowledge}}`，没有「本次检索到的事实」占位符。

## 4. 方案总览

生成段数据流（★ 为本次新增/改造；路由、安全闸、外发、防双发全部不动）：

```
discussing → 拉上下文（不变）
  → routeSkill 技能路由（不变）
  → ★ 按技能检索：skill.retrieval.enabled 时调 RagPort.retrieve(question, {filter, topK})
       命中 → formatChunks（过滤 minScore、截断 maxChars）拼装文本
       失败/超时/零命中 → 空串（静默降级，不重试不阻断）
  → renderPrompt（技能模板 + {{knowledge}} 静态口径 + ★ {{retrieved}} 检索事实）
  → agent.complete → onCall 落 agent_logs（不变；检索结果随 prompt 天然留痕）
  → reviewMode 转审 / commitDraft / 外发段（全部不变）
```

## 5. 决策记录

| 决策 | 选择                                                                                                                                                                                  | 理由                                                                                                                                            |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| D-A  | 新增 `infra/rag/` 端口-适配器四件套（port / rag-http / mock / index）                                                                                                                 | 对齐 `infra/agent` 既有模式；检索是独立外部依赖，与 Agent 调用生命周期、配置、故障特征都不同，不并入 `infra/agent`                              |
| D-B  | 检索走 `bridge.httpPostJson` 宿主通道，适配器暴露可选 `transport` 组合点                                                                                                              | 与大模型对接完全同构：WebView CORS 由宿主规避、超时宿主强制、测试注入 fetch；零 Rust                                                            |
| D-C  | 配置挂 `WelinkSettings.rag: WelinkRagSettings`（ragSource/baseUrl/endpoint/apiKey/timeoutMs/topK/minScore/maxChars/fallbackRetrieve），normalize 三层兜底                             | 对齐 agent 块惯例；`ragSource: 'mock'\|'http'` 真假分离；浏览器强制 mock                                                                        |
| D-D  | 技能绑定检索：`WelinkSkill` 增 `retrieval: { enabled: boolean; filter?: string }`；兜底技能由 `rag.fallbackRetrieve` 控制                                                             | 检索范围随技能走（故障咨询查故障库、进度查询查流程库），filter 语义 = 传给 RAG 服务的过滤条件（标签/分类），格式属 [RAG-ASSUME]；与技能路由正交 |
| D-E  | 注入用**新占位符 `{{retrieved}}`**，不复用 `{{knowledge}}`                                                                                                                            | 语义分离：「静态口径（人维护）」vs「本次检索事实（机器取回）」；模板作者各自决定位置；旧模板不含 `{{retrieved}}` 行为零变化                     |
| D-F  | 知识库管理零 Rust：清单存 `knowledge/index.json`（fsWrite 自动建父目录），新建/编辑/下架/登记；**删除 = 下架**（fs 通道无删文件能力，物理删除列非目标）；手动放入的文件用「登记」录入 | 加 `fs_list`/`fs_delete` 各要多一个 Rust 命令且本期收益低；下架语义诚实可见（md 留存数据根，不丢数据）；`index.json` 是唯一真源，登记即对账     |
| D-G  | 检索结果注入生成 prompt 后随 R4 语料（`welink_agent_logs`）天然留痕；检索调用本身**不单独建表**                                                                                       | 零迁移；「检索到了什么」看生成 prompt 全文即可回溯；独立 rag_logs 表等真实运维需求出现再立变更                                                  |
| D-H  | 检索失败/超时/零命中一律空串降级，logger.warn 留运行日志，不重试不阻断                                                                                                                | 检索是增强不是依赖——降级后回复质量回到「无检索」水平而非失败；与「检索不重试」的建群式保守立场一致                                              |
| D-I  | 检索内容（知识库片段）视为可信文本不消毒，但拼接结构（`【知识N】(来源, 相关度)` 头）由本端生成；会话内容消毒路径不变                                                                  | 对齐 D8；score/来源是本端计算/透传，攻击面 = 用户自己的知识库；`maxChars` 截断防爆                                                              |
| D-J  | RAG 检索失败样本不进 agent_logs（那是模型调用语料），失败只进运行日志                                                                                                                 | agent_logs 的语义是「模型输入输出」，混入检索错误会污染 R4 语料分析                                                                             |

## 6. 数据与契约

### 6.1 配置（`config.json` → `WelinkSettings.rag`）

```jsonc
{
  "rag": {
    "ragSource": "mock", // mock | http
    "baseUrl": "http://rag.intranet.example.com", // RAG 服务根地址
    "endpoint": "/search", // 检索路径（惯用）
    "apiKey": "", // Bearer 头，可空
    "timeoutMs": 10000, // 1s–60s
    "topK": 4, // 1–10
    "minScore": 0, // 0–1，低于阈值丢弃
    "maxChars": 1200, // 注入提示词的检索文本总上限
    "fallbackRetrieve": false, // 兜底技能（通用助手）是否也检索
  },
}
```

归一化三层兜底对齐 agent 块：非 http → mock；baseUrl 须 http(s) URL；timeoutMs clamp
1000–60000；topK 1–10；minScore 0–1；maxChars 200–4000；apiKey trim。

### 6.2 技能绑定（`WelinkSkill` 扩展）

```ts
retrieval: {
  enabled: boolean   // 该技能是否在生成前检索
  filter?: string    // 传给 RAG 的过滤条件（标签/分类，格式属 [RAG-ASSUME]）
}
```

老配置缺字段 → `{ enabled: false }`（零迁移，行为与升级前一致）。兜底技能的检索开关
= `rag.fallbackRetrieve`（不占技能字段）。

### 6.3 端口契约（`src/infra/rag/port.ts`）

```ts
export interface RagChunk {
  content: string
  score: number
  source: string   // 来源标识（文档名/片段位置），RAG 未回传时为空串
}
export interface RagQuery {
  query: string
  filter?: string
  topK?: number    // 缺省用 settings.rag.topK
}
export interface RagPort {
  retrieve(query: RagQuery): Promise<RagChunk[]>
}
export class RagError extends Error {
  constructor(message: string, readonly kind: 'transport' | 'parse' | 'empty', override readonly cause?: unknown)
}
export interface RagClient extends RagPort {
  /** 与 AgentClient.onCall 同构的录音钩子（本期 UI 不消费，测试与调试用） */
  onCall(handler: (record: { query: RagQuery; chunks: RagChunk[]; latencyMs: number; error: string }) => void): void
}
```

### 6.4 知识库清单（`knowledge/index.json`）

```jsonc
{ "docs": [{ "file": "vpn-faq.md", "title": "VPN 常见问题", "updatedAt": "2026-10-05 10:00:00" }] }
```

- 新建：fsWrite `knowledge/<slug>.md` + 重写 index.json；编辑：fsWrite 覆盖 + 更新清单；
- **下架**：仅从清单移除（md 文件留存数据根——fs 通道无删文件能力，物理删除列非目标）；
- **登记**：手动放入 `knowledge/` 的文件，输入文件名 + 标题录入手动清单（应用侧无法列目录，
  登记是对账入口）；
- fsRead 不存在的文件返回 null → 打开失败给「文件已被移走」的可行动提示。

## 7. [RAG-ASSUME] 假设清单（对接真实服务前逐项核实）

与 `[LLM-ASSUME]` 同款约定：对接前 `grep -rn "RAG-ASSUME" src/` 逐项核对，核实后更新或删除：

1. **端点**：POST `{baseUrl}{endpoint}`（惯用 `/search`）；路径拼接规则同 LLM。
2. **鉴权**：`Authorization: Bearer <apiKey>`（apiKey 非空才带头）；网关若用自定义头需改适配器。
3. **请求体**：`{ "query": string, "top_k": number, "filter": string }`（filter 空省略；top_k 缺省
   服务端自定）。
4. **响应形状**：`{ "results": [ { "content": string, "score": number, "source": string } ] }`；
   字段候选容错：容器 `results|chunks|hits|data`、正文 `content|text|chunk`、分值
   `score|similarity|similarity_score`、来源 `source|doc|title`。
5. **score 语义**：越高越相关（0–1）；若服务相反，在适配器翻转并在清单标注。
6. **query 语言**：中文原文直传，不做改写（改写列扩展点）。
7. **CORS**：桌面模式经宿主通道 `http_post_json` 规避（LLM 同处置已核实可行）；浏览器模式强制 mock。
8. **响应上限**：宿主通道 2MB 截断（topK ≤10 时不会触达；触达即视为 parse 错误降级）。

## 8. 对接真实 RAG 服务 SOP

1. 拿到 `baseUrl` / `endpoint` / `apiKey`（如有）；`curl -X POST` 打一遍检索最直接。
2. 按 §7 逐项核实假设，更新或删除 `[RAG-ASSUME]` 标签。
3. 设置页 → 新「知识检索（RAG）」卡：来源=模型检索服务，填三项，`topK/minScore` 按服务建议值。
4. 「测试检索」按钮：固定探测 query（如「VPN 连不上」），显示耗时与命中片段摘要（独立实例，
   不污染任何语料）。
5. 技能编辑器里开「知识检索」，需要的话填 filter；模板中 `{{retrieved}}` 放到合适位置
   （建议在「需要回复的消息」之前，并配一条「仅依据检索到的知识回答，知识库没有的不要编造」约束）。
6. `sendMode=manual` 跑几条真实消息：人工核对「检索片段 → 草稿引用」的忠实度（Agent 回溯里看
   prompt 全文），确认没有编造后转 auto。
7. 按 skill 维度观察 R4 语料的 👍/👎 变化评估准确性收益。

## 9. 测试与验证计划

| 测试                                | 覆盖                                                                                                                                                 |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/types/welink.spec.ts`          | rag 配置归一化三层兜底、skill.retrieval 零迁移、老配置零迁移                                                                                         |
| `src/infra/rag/ports.spec.ts`       | 请求体形状/Bearer trim/严格解析与字段容错/超时分类/公网 literal IP 守卫/浏览器强制 mock/mock 命中与故障注入                                          |
| `src/infra/agent/prompt.spec.ts`    | `{{retrieved}}` 注入、空缺省空串、unknownPlaceholders 不再误报                                                                                       |
| `src/orchestrator/pipeline.spec.ts` | 检索注入（mock 命中 → prompt 含片段）/失败降级（prompt 无片段且生成继续）/禁用跳过（不发起检索）/fallbackRetrieve 开关/minScore 过滤与 maxChars 截断 |
| `src/components/welink/settings/*`  | 技能编辑器「知识检索」区契约、KnowledgeCard CRUD/登记/下架/降级提示契约                                                                              |
| 覆盖率基线                          | `orchestrator/**` ≥92%、`infra/db/**` ≥72% 不回退（infra/rag 新模块按 agent 惯例高覆盖）                                                             |
| 浏览器 GUI 走查                     | 知识库卡降级提示（web 模式）、技能检索区交互、mock RAG 命中的端到端回复（沿用长等待/几何点击经验）                                                   |

## 10. UI 设计要点

- **设置页新增「知识检索（RAG）」卡**（`RagSettingsCard.vue`，`weLink.rag` 唯一编辑器）：
  来源（模拟/检索服务）、服务地址、接口路径、API 密钥、超时、topK、minScore、maxChars、
  兜底技能检索开关、「测试检索」按钮 + 结果摘要；对齐 LlmSettingsCard 的防抖/透传惯例。
- **「知识库」卡**（`KnowledgeCard.vue`）：清单（标题/文件名/更新时间）、新建/编辑（标题 + 文件名
  slug + textarea）、下架（确认文案明示「文件保留在数据根 knowledge/ 目录，仅停止使用」）、
  登记手动文件；web 模式整卡降级提示。
- **SkillsSection 技能编辑器**增「知识检索」小区块：enabled 开关 + filter 输入 + 说明文案。
- **回复历史/回溯**：本期不加检索专属列（检索结果看 prompt 全文）；技能徽标体系已就绪不动。

## 11. 明确不做（非目标）

- 本地向量库 / 嵌入模型 / SQLite FTS5 兜底检索（零迁移承诺；FTS5 兜底列为扩展点，rusqlite
  bundled 具备能力）；
- 应用推送 md 建索引 / 索引状态管理（RAG 服务方职责）；
- md 物理删除、知识文档版本管理、回收站；
- 检索结果缓存与命中统计表（列扩展点）；
- query 改写/多轮检索/agentic 循环（端口单次 retrieve，语义对齐 AgentPort 的最小化立场）；
- 安全闸任何改动（检索只影响「生成什么」）。

## 12. 扩展点（本期预留，不实现）

1. FTS5 本地兜底检索：`knowledge/*.md` 分块入 SQLite FTS 虚表（migration v6），RAG 不可用时
   降级（rusqlite bundled 已具备 FTS5 能力，实地核实后再立变更）；
2. 检索命中统计（skill × 命中率 × 采纳率）随 R4 语料导出一起做；
3. 按技能的「检索 query 模板」（问题改写后检索）；
4. 知识文档变更指纹（hash）与「RAG 索引可能过期」提醒。

## 13. 实施清单（对应 OpenSpec tasks 分解）

| 文件                                                                                                               | 改动                                                                                           |
| ------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| `src/types/welink.ts`                                                                                              | `WelinkRagSettings`、`RagSource`、`WelinkSkill.retrieval`、默认值与 normalize 收敛             |
| `src/infra/rag/port.ts` `rag-http.ts` `mock.ts` `index.ts`                                                         | 端口/HTTP 适配器/mock/工厂（transport 注入 + IP 守卫 + [RAG-ASSUME] 标注）                     |
| `src/infra/agent/prompt.ts`                                                                                        | `{{retrieved}}` 占位符与 PromptInput.retrieved                                                 |
| `src/orchestrator/pipeline.ts`                                                                                     | generateOne 检索注入与静默降级                                                                 |
| `src/components/welink/RagSettingsCard.vue`、`KnowledgeCard.vue`、`settings/SkillsSection.vue`、`SettingsView.vue` | RAG 配置卡、知识库卡、技能检索区、卡片挂载                                                     |
| `src/types/index.ts`、`src/api/*`                                                                                  | 如需 re-export；Bridge 无改动                                                                  |
| openspec                                                                                                           | `add-welink-rag-retrieval` 提案 + 归档后同步 `welink-auto-reply`、新增 `knowledge-base` 主规格 |
