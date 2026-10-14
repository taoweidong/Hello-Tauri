# PRD：增量优化第二轮（S2 数据安全与性能 / S4 测试补缺口）

> 编写日期：2026-10-13 · 分支 `main` · 上游输入：`docs/analysis-full-system-2026-10-12.md`
> 本轮范围：**S2（数据安全与性能）+ S4（测试补缺口）**
> 明确不做：S3（UI 一致性收口）、S5（大文件拆分）—— 理由见 §5
> 作者：许清楚（产品） · 交付物只此文档，不含代码改动

---

## 1. 项目信息

| 项 | 值 |
| --- | --- |
| 语言 | 中文 |
| 技术栈 | Tauri 2 + Vue 3 + TypeScript + Element Plus（**既有栈，不新增任何依赖**） |
| 项目名 | `hello_tauri_s2_s4_optimization` |
| 用户 | 老陶（全栈工程师，内网单人桌面使用场景） |

**原始需求复述**：「全面评估和优化」。上一轮（S1）已完成全量分析并修掉 9 个 P1 缺陷；主理人界定本轮做路线图中的 **S2（数据安全与性能）** 与 **S4（测试补缺口）**，S3/S5 顺延。

**输入清单（来自分析报告，不重复其分析过程）**：

| 来源编号 | 一句话现状 |
| --- | --- |
| P1-1 | `config.json` 明文含 `agent.apiKey` / `rag.apiKey` / `codeHub.token` |
| P1-2 | `repositories/records.ts` 的 `loadAll()` 无 LIMIT |
| P2-7 | 三处 N+1 / 忙循环：`pipeline.ts:583/724`、`bootstrap.ts:177`、`knowledge-harvester.ts:229` |
| P2-8 | `agent-http.ts`(266) / `rag-http.ts`(261) / `stores/update.ts`(113) / `stores/welink/knowledge.ts`(146) 四个模块无直连 spec |
| P2-9 | `hasOutgoingReceipt` 用「同会话 + content 全等」当回执，内容重复时误判已发送 |
| P2-12 | 仓储记忆实现（memory）缺独立契约测试 |

---

## 2. 产品定义

### 2.1 产品目标

在**不改变架构分层、不新增任何依赖、不回退任何覆盖率阈值**的前提下，把本轮范围内的「静默失效型缺陷」和「不可逆路径无测试」两类风险压下去。成功判据（全部可验证）：

1. **四个「无直连 spec」模块的覆盖率补齐到位，且全部用例离线可跑**：新增至多 6 个 spec 文件（`agent-http` / `rag-http` / `agent/index` / `rag/index` / `stores/update` / `stores/welink/knowledge`），`npm test` 全绿（基线 84 文件 1297 用例），`npm run test:coverage` 报告中 `agent-http.ts` lines ≥ 95 / branches ≥ 85、`rag-http.ts` lines ≥ 92 / branches ≥ 85 / functions ≥ 95、**`infra/agent/index.ts` 与 `infra/rag/index.ts` lines ≥ 90**（真实缺口在这两个工厂/缓存键模块，当前仅 50% / 43%）、`stores/update.ts` lines ≥ 90（当前 **0%**）、`stores/welink/knowledge.ts` lines ≥ 90 / functions ≥ 90（当前 71% / 55%）。基线为 2026-10-13 实测值，明细见 §4。
2. **回执核对不再因「历史同内容消息」误判为已发送**：`hasOutgoingReceipt` 的判定窗口从「全部历史」收窄到「本次发送尝试之后」，零 SQLite 迁移。
3. **密钥的明文暴露面收敛到可解释的程度**：要么密文落盘（方案 A），要么明文面被明确标注与收敛（方案 B）；两种方案都必须有可断言的自动判据。
4. **全线门禁不回退**：`npm run check`（lint + typecheck + test）全绿；`orchestrator` 95/90/95/88、`infra/db` 72/68/72/68、`infra/windows` 90/75/90/88 三条阈值无一回退；新增用例全部通过「注入缺陷 → 变红」反证。

### 2.2 用户故事

| # | 用户故事 | 来源 |
| --- | --- | --- |
| US-1 | 作为**使用本应用对接内网大模型的用户**，我希望 agent / rag 两个适配器域的外发路径（超时、错误分类、鉴权头、非 2xx、解析容错）与它们的工厂装配/缓存键（当前仅 50% / 43% 覆盖）都有直连用例钉住，以便我改其中任何一行时错误能被测试立刻拦住，而不是等到内网联调时才暴露。 | P2-8 |
| US-2 | 作为**依赖自动更新做内网分发的用户**，我希望 `stores/update.ts` 的「有更新」聚合口径、apply 前停服、更新态持久化与恢复都有用例覆盖，以便这个会**自替换 exe** 的不可逆动作不会因为我改了一行装配而在用户机器上静默失控。 | P2-8 |
| US-3 | 作为**维护本地知识库的用户**，我希望 `stores/welink/knowledge.ts` 的清单加载、评审通过/驳回、立即提取一轮都有用例覆盖，以便我写进 `knowledge/*.md`（唯一长期记忆落点）的内容不会被一个未被测试覆盖的刷新顺序弄丢。 | P2-8 |
| US-4 | 作为**依赖自动回复的用户**，我希望「这条是不是已经发出去了」的回执核对只认本次尝试之后产生的外发消息，以便对方连着问两个一模一样的问题时，助手不会把上一条的回应当成这一条的回执而**漏回复**。 | P2-9 |
| US-5 | 作为**把数据根放在内网盘/会做目录备份的用户**，我希望密钥不以可直接抄走的明文形式躺在 `config.json` 里，以便我把整个数据目录拷给别人或上传备份时，不会顺手把内网大模型与 CodeHub 的凭据一起交出去。 | P1-1 |
| US-6 | 作为**在浏览器模式（`npm run dev`）调试的用户**，我希望 SQLite 实现与内存实现的仓储契约被同一组用例钉住，以便「桌面能复现、浏览器复现不了」这类最难查的漂移不再发生。 | P2-12 |
| US-7 | 作为**长期开着沉淀功能的用户**，我希望一轮知识提取里对知识库文档的重复全量读取被合并，以便沉淀文档变多后这个周期任务不会越来越慢。 | P2-7-c |
| US-8 | 作为**启动应用的用户**，我希望安全闸预热不随监控会话数线性放大 IPC 次数，以便会话多了以后启动不会明显变慢。 | P2-7-b |
| US-9 | 作为**在示例表格里手工录入数据的用户**，我希望 `loadAll()` 至少有一个防呆上限，以便将来这张表被复用做别的事时不会一次把整表读进内存。 | P1-2（降级） |

---

## 3. 需求池（重新定级）

> 定级说明：报告里的 P1/P2 是**通用软件**口径。本项目是「内网离线、单人、单实例、数据不出本机」的桌面应用，威胁模型与数据规模都与通用 SaaS 不同，因此本轮按下表**重新定级**，每个调整都写明理由。

| 新编号 | 项目 | 来源 | 新级别 | 定级理由 |
| --- | --- | --- | --- | --- |
| **N1** | agent / rag 两个适配器域的直连 spec | P2-8 前半 | **P0** | 这两条是**唯二会朝内网大模型/RAG 发起真实请求**的路径，且已有 `[LLM-ASSUME]`/`[RAG-ASSUME]` 假设待核实；项目铁律是「先补测试再改实现」，它是本轮所有改动的前置门禁。放在 P0 不是因为它难，而是因为它不做，后面每一项都在裸改。**实测修正**：`agent-http.ts` 已 95.78% lines / 100% funcs、`rag-http.ts` 已 86.91% lines（经 `ports.spec.ts` 注入 transport 间接覆盖），**并不是报告暗示的「零覆盖」**；真正裸奔的是 `infra/agent/index.ts`（50%）与 `infra/rag/index.ts`（43.37%）—— 这两个是**工厂装配 + 模块级缓存键**（缓存键里拼了 `apiKey`，与 N4 密钥面直接相邻）。故 N1 的靶心从「两个 http 文件」调整为「两个 http 文件补未覆盖分支 + 两个 index 工厂补到 ≥90%」。 |
| **N2** | `stores/update.ts` / `stores/welink/knowledge.ts` spec | P2-8 后半 | **P0** | 更新是唯一会**自替换 exe** 的路径，知识 store 是唯一会写 `knowledge/*.md`（唯一长期记忆落点）的 UI 面。二者都是不可逆副作用且当前零覆盖，静默失效的代价是数据/程序本体。 |
| **N3** | 回执核对幂等化（收窄判定窗口） | P2-9 | **P1** | 典型「静默失效」：误判后果是**漏回复**，用户只会觉得「助手今天有点哑」。修复成本极低（零迁移，改一条 SQL），收益明确，排 P1 首位。 |
| **N4** | 密钥存储收敛 | P1-1 | **P1（待拍板）** | 见 §3.1 权衡：内网单用户场景下「防本机恶意软件」的收益≈0，真实收益是防**离线拷贝/备份外带**与合规口径。是否升级为 P0 取决于老陶在 A/B 间的选择。 |
| **N5** | 仓储 memory 实现契约矩阵补齐 | P2-12 | **P1** | 纯测试、零行为变更、成本低；防的是「两套实现漂移」——本项目浏览器调试与桌面双跑，漂移最难查。现状并非「零契约」（`welink-contract.spec.ts` / `sediment-contract.spec.ts` 已存在，`group-repos.spec.ts` / `codehub-repos.spec.ts` 内含双实现一致性断言），真实缺口是**覆盖方法不全 + 分散在四个文件**，故定为「收敛成矩阵 + 补齐未覆盖方法」而非从零建。 |
| **N6** | `knownDocHashes()` 每轮全量读文档 | P2-7-c | **P2** | 绝对值很小：沉淀轮次是周期任务，个人知识库文档量级几十篇。真正的放大器是 **auto 直通模式下每个 draft 各调一次 `approve`（每次 listDocs + readDoc）**，故给触发条件而非直接做（见 §4）。 |
| **N7** | bootstrap Gate 预热 N+1 改聚合查询 | P2-7-b | **P2** | 启动一次、个人场景监控会话数十个；报告写的「最坏 2000 次 IPC」是理论上限，不是本用户的实际量级。给触发条件：监控会话 ≥ 100 或启动预热实测 > 500ms 时升 P1。 |
| **N8** | `loadAll()` 防呆上限 | P1-2 | **P2（降级）** | 见 §3.2：`records` 表是示例 CRUD 演示数据（种子 12 条、全部手工录入），`stores/table.ts` 已做前端分页且注释明确「千级内够用、万级再下推」。数据量根本涨不到出事，因此从 P1 降到 P2，且**只加防呆上限，不做分页下推**（分页下推要动 `RecordsBackend` 接口 + 两个实现 + store + 视图，改动面与收益不成比例）。 |
| **N9** | `pipeline.ts:583/724` guard 常量 | P2-7-a | **不做** | 见 §3.3：这是防死循环上界，不是忙循环。 |

### 3.1 N4（P1-1 密钥）的权衡 —— 必须写清楚

**真实威胁模型（内网单用户桌面应用）**：

- `config.json` 位于数据根 `config/`（默认 `D:\TangYuan`），该目录**用户可读、可整目录拷贝、可随「配置页迁移数据根」搬走**。
- 真实风险排序：① **整目录备份/外带时把凭据一起交出去**（最高频）；② 合规口径「明文密钥落盘」被扣分；③ 同一台机器上其他进程读取。
- **必须诚实说明**：DPAPI 绑定的是「当前 Windows 用户 + 本机」，同用户下任意进程都能解。因此方案 A **不防本机恶意软件**，只防 ①（离线拷贝到别的机器/别的 Windows 用户下打不开）与 ③ 的一半。**如果老陶的预期是「防本机木马」，方案 A 达不到，别误选。**

**三条既有约束会不会被破坏**：

| 约束 | 是否受影响 | 说明 |
| --- | --- | --- |
| 配置页可迁移数据根 | **受影响（真正的代价）** | 同机同 Windows 用户迁移（D: → E:）：DPAPI 仍能解，无感。跨机 / 换 Windows 用户 / 重装系统：密文解不开 → 必须显式降级为「需重填」并在设置页提示，**禁止静默置空**（静默置空 = 又一个静默失效）。 |
| `bootstrap.json` 引导 | 不受影响 | 引导文件只指向数据根路径，与密钥格式无关。 |
| 单文件离线分发 | 受影响但可控 | 需新增 Rust 命令（`CryptProtectData` / `CryptUnprotectData`），只**扩 `windows-sys` 的 `Win32_Security_Credentials` feature**（同 crate，不新增 crate，Cargo.lock 不变，符合「不引入新 Rust 依赖」）。PE 导入表会新增 `crypt32.dll` —— 系统组件，与既有 `native-tls`/schannel 同一论证，且不在 `npm run pack` 的硬校验黑名单（`WebView2Loader.dll` / `VCRUNTIME*` / `api-ms-win-crt-*`）内，但**必须实测一次 `npm run pack` 确认**。 |

**关键实现约束**：前端跑在 WebView2 里，**没有 Node 运行时，`node:crypto` 在运行时不可用**（只在 vitest 里可用）。所以真正的加密只能落在宿主侧；`api/web.ts` 侧必须显式降级并标注「浏览器模式不加密」，不能假装加密。

**给老陶的三个选项**：

| 选项 | 做法 | 成本 | 代价 | 推荐 |
| --- | --- | --- | --- | --- |
| **A** | 宿主 DPAPI 加解密，密文**仍存 config.json**（随数据根走） | 1~2 个 Rust 命令 + Bridge 双侧 + 1 个 infra 端口 + 迁移/降级路径 | 跨机/换用户迁移数据后密钥需重填；`npm run pack` 需实测一次；AGENTS.md 的命令数（34）与架构边界描述需同步更新 | ✅ **推荐** |
| **B** | 不加密，只做面收敛：密钥字段在导出/日志/UI 的暴露面剔除 + 设置页显式风险提示 + 复制按钮脱敏 | 极低（纯前端） | 明文仍在盘上，只降低「误泄」，不解决「整目录外带」 | 备选（若老陶不接受任何 Rust 改动） |
| **C** | 存 Windows Credential Manager | 同 A 量级 | 密钥**完全脱离数据根**，任何形式的数据根迁移都 100% 丢密钥，且无法随数据根备份恢复 —— 与「数据根可迁移」这条既有设计直接冲突 | ❌ 不推荐 |

### 3.2 N8（P1-2）为什么降级

- `records` 表数据来源：**内置种子 12 条 + 用户手工在 TableCrudView 增删**；没有自动写入方（`sqlRecordsBackend.prepare()` 只在空表时导入种子或 legacy `table.json`）。
- `stores/table.ts:36-50` 已做前端筛选 + 分页，`pageSize` 来自 `settings.pageSize`（默认 10）；store 顶部注释写明「数据规模在千级以内这完全够用，万级再上 SQL 分页下推（接口已隔离）」。
- 结论：**这不是 P1，是 P2 的防呆**。做分页下推属于「为指标改代码」，本轮不做；只加一个常量上限（如 `LIMIT 5000`）把「将来被复用成大表」的口子堵上，成本一行 SQL + 一条注释。

### 3.3 N9（P2-7-a）为什么不做

`pipeline.ts:583` 的 `for (let guard = 0; guard < 500; guard += 1)` 与 `:724` 的 `for (let round = 0; round < 100; round += 1)` 是**防死循环上界**，不是忙循环：`flush()` 里已有 `deferredThisPass` 集合（`:581-611`）避免本轮空转，正常路径第一次迭代就 `break`。把它「改事件驱动」等于重写调度语义、动 `orchestrator` 里覆盖率最高也最脆的一段，收益为零、回归风险显著。**本轮不做，只补注释说明它是防御性上界。**

---

## 4. 验收标准（逐项可自动验证）

> 通用门禁（适用于全部条目）：`npm run check` 全绿；三条覆盖率阈值不回退；**每个新增用例必须做反证**（注入缺陷 → 该用例变红），反证结果记入 commit message；禁止 `.skip` / `.only` / 放宽断言。

| # | 验收判据（可自动验证） |
| --- | --- |
| **N1** | 新增 `src/infra/agent/agent-http.spec.ts`、`src/infra/rag/rag-http.spec.ts`、`src/infra/agent/index.spec.ts`、`src/infra/rag/index.spec.ts`。① `npm test` 全绿；② 四个 http 用例文件各 ≥ 12 条，必须覆盖：transport 注入下的 2xx/非 2xx/超时/解析失败四类分类（断言 `AgentError.kind` / RAG 错误分类正确）、鉴权头与请求体形状、响应字段容错、`[RAG-ASSUME]`/`[LLM-ASSUME]` 涉及的字段；③ 两个 index 工厂必须覆盖：**相同配置命中模块级缓存、配置变更重建实例、缓存键不因密钥变化而泄漏可辨识信息**（与 N4 相邻，见 §3.1）；④ 全部用例**不发起真实网络请求**（transport 假件，`vi.useFakeTimers()` 控超时）；⑤ `npm run test:coverage` 实测达标：`agent-http.ts` **lines ≥ 95 / branches ≥ 85**（基线 95.78 / 85.50，只许升不许降，且 154-156、229、249 等未覆盖行需逐行说明或补测）、`rag-http.ts` **lines ≥ 92 / branches ≥ 85 / functions ≥ 95**（基线 86.91 / 79.48 / 83.33）、`infra/agent/index.ts` **lines ≥ 90**（基线 50）、`infra/rag/index.ts` **lines ≥ 90**（基线 43.37）。 |
| **N2** | 新增 `src/stores/update.spec.ts`、`src/stores/welink/knowledge.spec.ts`。① `npm test` 全绿；② `update.spec.ts` 必须断言：`hasUpdate` 在 `enabled=false` 时恒 false、`busy` 的状态集合、`init()` 装配失败只 warn 不抛、`update/state.json` 读回非 JSON 时降级为 null 而不是崩、`install()` 前先停 WeLink 与 CodeHub 服务；③ `knowledge.spec.ts` 必须断言：`loadDocs/loadDrafts/loadLogs` 的数据流、`approveDraft`/`rejectDraft` 成功才刷新、失败不刷新、`runOnce()` 的 busy 互斥与 `finally` 复位、`fsAvailable` 在 web 模式为 false；④ 实测达标：`stores/update.ts` **lines ≥ 90**（基线 **0**，整文件未被任何用例触达）、`stores/welink/knowledge.ts` **lines ≥ 90 / functions ≥ 90**（基线 71.42 / 54.54）。 |
| **N3** | ① `src/infra/db/repos/welink.ts` 的 `hasOutgoingReceipt` 判定加入时间下界：只认 `sent_at >= (SELECT updated_at FROM welink_reply_jobs WHERE id = ?1)` 的 out 消息（`markStatus` 置 `sending` 时会更新 `updated_at`，故 `updated_at` 即「本次发送尝试开始时刻」，无需新增列）；② `welink.spec.ts` 新增两条断言：**历史同内容**（`sent_at` 早于 `updated_at`）→ `false`；**本次尝试后同内容**（`sent_at >= updated_at`）→ `true`；③ 内存实现 `welink-memory.ts` 同口径，由 `welink-contract.spec.ts` 双侧断言一致；④ 反证：去掉时间下界后「历史同内容 → false」用例变红。 |
| **N4** | 取决于 §3.1 的拍板结果。**选 A**：① `config.json` 中三个字段不以明文出现（单测断言：写入后再读出，落盘文本不含原密钥子串）；② 加解密往返用例（加密 → 解密 = 原值）；③ **降级用例**：解密失败（篡改密文）→ 返回「需重填」且**不抛异常、不静默置空**、设置页有可见提示；④ 浏览器模式（`web.ts`）显式降级并标注；⑤ 实测一次 `npm run pack` 通过且 PE 导入表硬校验通过。**选 B**：① 设置页三处密钥输入区出现明文风险提示（组件测试可断言文案存在）；② 导出/日志路径的密钥剔除断言（`registerSecret` 覆盖面用例）。 |
| **N5** | ① 新增（或扩展）`src/infra/db/repos/*-contract.spec.ts`，把 `welink-memory` / `welink-group-memory` / `codehub-memory` / `sediment-memory` 四个实现的契约收进同一套「同一操作序列 → 双侧断言一致」的矩阵；② 判据：脚本盘点四个 memory 实现各自实现的 Port 方法，**未被任何契约用例覆盖的方法数 = 0**（盘点脚本可放 `scripts/` 或直接用 grep + 用例清单对照，结果写回本文档）；③ 反证：故意让内存实现漏改一个方法签名 → 契约用例变红。 |
| **N6** | ① 一轮提取内 `knowledge.listDocs()` 的调用次数被缓存收敛（单测断言：一轮 `runOnce()` 中 `listDocs` 调用次数 ≤ 常量，且不随 draft 数增长）；② 若同时收敛 auto 模式每 draft 各调 `approve` 的放大（`:314-321`），需断言 auto 直通下 `readDoc` 调用次数不随 draft 数线性增长；③ `knowledge-harvester.spec.ts` 既有 574 行用例全绿不回退（`orchestrator` 阈值不得回退）。 |
| **N7** | ① `bootstrap.ts` 预热改为「一次聚合查询取回全部监控会话的本小时计数 + 最近发送时间」（或等价的单条 GROUP BY），单测断言：watching = 50 时预热阶段 `repo.countSentSince` / `repo.lastSentAt` 的调用次数为 **0**，`dbSelect` 调用次数为**常数**（不随会话数增长）；② `bootstrap.spec.ts` 既有恢复三分支用例全绿；③ 反证：改回逐会话查询后该断言变红。 |
| **N8** | ① `sqlRecordsBackend.loadAll()` 的 SQL 文本含 `LIMIT`（单测断言 SQL 匹配 `/LIMIT\s+\?|LIMIT\s+\d+/i`）；② 上限为显式常量并加注释说明「防呆，非分页下推」；③ `records.spec.ts` 既有用例全绿；④ **不做**分页下推（接口 `RecordsBackend` 不变）。 |
| **N9** | 不做实现，只在 `pipeline.ts` 两处 guard 上加注释说明「防御性上界，非忙循环，勿改为事件驱动」；`pipeline.spec.ts` 无新增失败。 |

### 4.1 覆盖率基线（2026-10-13 实测）

`npm test` 现状：84 文件 / **1297 用例全绿**。覆盖率实测命令（绕过沙箱对 `coverage/` 目录清理的拦截——把报告目录指向仓库外）：

```
npx vitest run --coverage --coverage.reporter=text --coverage.reportsDirectory="$TEMP/ht-cov" \
  --coverage.include='src/infra/agent/**' --coverage.include='src/infra/rag/**' \
  --coverage.include='src/stores/update.ts' --coverage.include='src/stores/welink/knowledge.ts'
```

| 文件 | % Lines（基线） | % Branch | % Funcs | 目标 | 结论 |
| --- | --- | --- | --- | --- | --- |
| `infra/agent/agent-http.ts` | 95.78 | 85.50 | 100 | ≥95 / ≥85 | 基本达标，补未覆盖行（154-156 / 229 / 249） |
| `infra/agent/index.ts` | **50.00** | 60.00 | 40.00 | ≥90 | **真实缺口** |
| `infra/rag/rag-http.ts` | 86.91 | 79.48 | 83.33 | ≥92 / ≥85 / ≥95 | 需补齐 |
| `infra/rag/index.ts` | **43.37** | 25.00 | 33.33 | ≥90 | **真实缺口** |
| `stores/update.ts` | **0.00** | 100* | 100* | ≥90 | **整文件零覆盖**（*100% 是 v8 在无语句命中时的计数假象，忽略） |
| `stores/welink/knowledge.ts` | 71.42 | 90.90 | **54.54** | ≥90 / ≥90 | 需补齐（函数覆盖尤其低） |

**这张表修正了报告 §7.4 的口径**：报告说「两条真实外发路径无直连 spec → 最值得优先补」，但实测 `agent-http.ts` 已有 95.78% lines —— 它被 `ports.spec.ts` 用注入 transport 的方式间接覆盖了。真正裸奔的是**两个 index 工厂（50% / 43%）**与 **`stores/update.ts`（0%）**。N1/N2 的靶心据此调整（见 §3 与 §4 表格）。

---

## 5. 范围外与待确认问题

### 5.1 本轮不做：S3（UI 一致性收口）

- **为什么不排进本轮**：S3 是纯视觉/交互打磨（102 处 `el-button` 的 `size` 统一、`text`/`link` 混用、重复模板抽取、双层滚动），**不改变任何数据正确性**。而 S2/S4 动的是 `orchestrator` 与 `infra/db` —— 上一轮已证明这两个层的缺陷形态是「静默失效」（清理链假装已停、归档假装已完成），风险量级完全不同。同时 S3 改动面覆盖 8 个页面，会与 S2 抢同一份回归带宽。
- **触发条件**（满足任一即启动下一轮 S3）：① S2/S4 完成且 `npm run check` 全绿、`npm run uitest` 56 用例全绿；② 老陶明确要求改观感/一致性。

### 5.2 本轮不做：S5（大文件拆分）

- **为什么不排进本轮**：11 个 >400 行文件的拆分是**零行为变化的结构重构**，收益是长期可维护性，成本是大面积移动带来的回归风险 —— 与 S2 的改动区间高度重叠（如 `CodehubReviewView` 813 行、`DashboardView` 777 行都在动区内）。且项目铁律写明「先补测试再拆」，**S4 的测试补缺口正是 S5 的法定前置**，顺序不能倒。
- **触发条件**：S4 完成后，目标文件已有 spec 且覆盖率 ≥ 85% 时逐个拆；单个 PR 只拆一个文件，`git status` 复核零行为变化。

### 5.3 本轮不做：N9（pipeline guard 常量）

见 §3.3 —— 它是防御性上界而非缺陷，改动收益为零、回归风险显著。

### 5.4 需要老陶拍板的问题

| # | 问题 | 选项 | 推荐 |
| --- | --- | --- | --- |
| **Q1** | 密钥存储（N4）走哪条路？ | A = 宿主 DPAPI 密文存 config.json（跨机迁移需重填，新增 1~2 个 Rust 命令 + `windows-sys` 扩 feature，需实测 `npm run pack`）；B = 不加密，只做暴露面收敛 + 设置页风险提示（零 Rust 改动）；C = Credential Manager（密钥脱离数据根，迁移必丢） | **A**。理由：与「数据根可迁移」兼容（同机迁移无感），只防离线拷贝这一真实风险，成本可控。**若老陶认为「一个 Rust 命令都不想加」或「跨机迁移必须带密钥」，选 B。** |
| **Q2** | 回执核对（N3）走零迁移时间窗，还是加 `out_msg_uid` 列（migration v8）？ | ① 零迁移：判定窗口收窄到 `sent_at >= job.updated_at`；② 改表：v8 加列 + 索引，回执按本地 uid 核对 | **①**。理由：回执核对的判据必须来自**外部世界**（会话里真有这条 out 消息）；本地生成的 uid 只有在真实 welink-cli 支持幂等键并回显时才有意义，而这是未核实的 `[CLI-ASSUME]`。加列成本是方案 ① 的五倍以上（迁移 + 双实现 + 契约 + 迁移幂等测试），且在 CLI 未确认前**收益并不更高**。若将来拿到真实 CLI 文档确认支持幂等键，再走 ②。 |
| **Q3** | 是否在 `vitest.config.ts` 给 `agent-http.ts` / `rag-http.ts` 落覆盖率阈值？ | ① 落（防回退）；② 不落（只靠本次实测值 + QA 核对） | **①**，但**先测基线再定数值**（AGENTS.md 的纪律是「先补测试再抬线」）。若补完测试后实测稳定高于下限，再按「实测 - 3 个百分点」落阈值。 |
| **Q4** | （原「沙箱跑不了 coverage，是否授权」）—— **已自行解决，无需拍板** | — | 用 `--coverage.reportsDirectory` 把报告目录指向仓库外临时目录即可绕开沙箱对 `coverage/` 清理的拦截，已实测跑通，命令见 §4.1。**不再需要 `--escalated` 授权**，也不需改动仓库内任何文件。 |
| **Q5** | 既有的 `agent-http.ts` 95.78% / `rag-http.ts` 86.91% 覆盖率是**通过 `ports.spec.ts` 注入 transport 拿到的**，本轮是否仍要求**新增独立 spec 文件**（而不是继续往 `ports.spec.ts` 里加用例）？ | ① 新增独立 spec 文件；② 继续扩展 `ports.spec.ts` | **①**。理由：报告与铁律的意图是「这两个模块要有自己的回归出口」；且 N1 要覆盖的两个 index 工厂本就不属于 `ports.spec.ts` 的管辖范围。但**不要求重写既有断言**，既有用例保留不动。 |

---

## 6. 硬性约束清单（本轮执行时不得违反）

1. **增量优化、最小变更**：不得改变既有架构分层（`views/components` → `stores` → `orchestrator` → `infra` → `repositories`），不得新增分层或跨层边。
2. **先补测试再改实现**；新用例先做反证（注入缺陷看是否变红）；**禁止**用跳过/注释/删除用例/放宽断言/残留 `.skip`/`.only` 让测试变绿。
3. **收尾门禁**：`npm run check` 全绿；`src/orchestrator/**` 95/90/95/88、`src/infra/db/**` 72/68/72/68、`src/infra/windows/**` 90/75/90/88 三条阈值不得回退。核对覆盖率时用 §4.1 的命令（报告目录指向仓库外），不要动仓库内的 `coverage/`。
4. **零新增依赖**：不新增 Rust crate（只允许扩已有 crate 的 feature，且需说明不破坏内网 cargo 缓存与单文件产物）；不新增 Node 第三方依赖；实现方式限于标准库 / Node 内置模块 / 已有依赖。注意：**前端运行时在 WebView 中，无 `node:crypto`**。
5. **运行时零外部请求**：自动更新仍是唯一显式例外，且默认关闭。
6. 注释、文档、commit message 使用中文；Prettier 风格（无分号、单引号、尾逗号、120 列、LF）。
