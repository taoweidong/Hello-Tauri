# Hello-Tauri 全量分析（第三轮）：功能 + UI + 优化规划

> 分析日期：2026-10-15 · 分支 `main` · 基线 `8aca70c`（第二轮 S2/S4 已合入）
> 上游输入：`docs/analysis-full-system-2026-10-12.md`（S1）、`docs/prd-optimization-s2-s4-2026-10-13.md`（S2/S4）
> 本轮定位：**S3（UI 一致性收口）+ 剩余 P0/P1 补漏**。前两轮已交付的功能/测试/安全项不重复展开。
> 说明：文中所有计数均为**实测**（grep / wc 取证），不是估算。

---

## 0. 总览

| 指标                          | 实测值（基线 8aca70c）                                                                              | 本轮后                               |
| ----------------------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------ |
| 源码规模                      | `.ts` 209 + `.vue` 35 = **244** 文件                                                                | +2（`utils/ui-action.ts` 及其 spec） |
| `.vue` 总行数                 | 12,960（35 文件）                                                                                   | 持平（本轮只改属性与样式）           |
| 单测                          | 91 文件 / **1396** 用例全绿                                                                         | 92 文件 / **1409** 用例全绿          |
| Rust 命令                     | 34（未改动）                                                                                        | 34                                   |
| 假设标签                      | 118 处（CLI-ASSUME 38 / MOCK-WIN 34 / MOCK-CLI 19 / RAG 8 / MOCK-UPDATE 7 / WIN 6 / UPD 5 / LLM 1） | 118（本轮不动，见 §4.3）             |
| 技术债标记（TODO/FIXME/HACK） | **0**                                                                                               | 0                                    |

**本轮的一句话结论**：前两轮把「数据正确性与测试覆盖」这两座山翻过去了，剩下的风险集中在**用户界面层的静默失效**——写库失败时开关已经动了、按钮点了没反应、重复提交没人拦。这类缺陷功能测试照绿（没人走失败路径），只会以「今天助手有点哑」「我明明开了啊」的形式浮现。本轮共落地 **10 组修复**（§5），并给出下一轮路线图（§6）。

---

## 1. 功能全景

### 1.1 页面矩阵（8 页 / 4 分组）

| 路由        | 页面         | 分组    | 核心能力                                            | 数据源               | 有无 spec |
| ----------- | ------------ | ------- | --------------------------------------------------- | -------------------- | --------- |
| `/`         | 工作台       | 工作台  | 聚合各域待办：待审回复、MR 队列、服务状态、托盘健康 | 多 store 聚合        | ✅        |
| `/table`    | 数据管理     | 工作台  | 示例 CRUD（种子 12 条）+ 分页/筛选/CSV 导出         | `records` 表         | ❌        |
| `/welink`   | WeLink 助手  | WeLink  | 4 个页签：消息中心 / 监控配置 / 回复历史 / 调用回溯 | welink-cli → SQLite  | 部分      |
| `/groups`   | 快速建群     | WeLink  | 建群模板 CRUD + 建群执行 + 建群历史                 | welink-cli + SQLite  | 部分      |
| `/codehub`  | CodeHub 检视 | CodeHub | MR 列表 / 详情 / 评论 / 自动同步（**纯只读**）      | codehub-cli → SQLite | ✅        |
| `/settings` | 配置         | 系统    | 全局偏好 + 各域设置卡（LLM/RAG/沉淀/安全/更新）     | config.json          | ❌        |
| `/envcheck` | 环境检测     | 系统    | 只读诊断命令注册表 + 系统信息探测                   | Windows 基础设施     | ❌        |
| `/about`    | 关于         | 系统    | 版本元数据（构建期注入）+ 更新入口                  | `__APP_VERSION__`    | ✅        |

### 1.2 能力域与分层落点

| 域               | 编排层（orchestrator）          | 端口/适配器（infra）      | 外发                            | 备注                                        |
| ---------------- | ------------------------------- | ------------------------- | ------------------------------- | ------------------------------------------- |
| WeLink 自动回复  | poller → pipeline → safety-gate | welink / agent / rag / db | **有**（消息外发）              | 唯一过安全闸的写外路径                      |
| 快速建群         | group-creation                  | welink（group 子域）      | **有**（建群）                  | 独立 `checkGroupAction`，不与发消息共用配额 |
| 知识沉淀         | knowledge-harvester             | knowledge / db            | 无（纯本地写 `knowledge/*.md`） | 不接安全闸、不产生回复任务                  |
| CodeHub 检视     | codehub-sync / codehub-detail   | codehub / db              | **无**（纯只读）                | 唯一子进程出口是「按条补拉详情」            |
| 自动更新         | update                          | update                    | 有（3 种 GET）                  | 默认关闭，唯一显式外部请求例外              |
| Windows 基础设施 | —                               | windows                   | 无（只读诊断）                  | 命令注册表 + Rust 白名单双层闸              |
| 服务驻留         | —                               | tray / autostart（Rust）  | 无                              | 托盘驻留 + 开机自启 + 单实例                |

---

## 2. UI 现状（实测）

### 2.1 组件规模

| 项                             | 值                                                                                                                                                                                                                           |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.vue` 文件 / 总行数           | 35 / 12,960                                                                                                                                                                                                                  |
| >400 行的文件                  | **11 个**：`CodehubReviewView` 814、`DashboardView` 777、`HistoryTab` 688、`ConfigTab` 632、`TraceTab` 620、`InboxTab` 607、`WeLinkView` 567、`TableCrudView` 551、`SettingsView` 522、`KnowledgeCard` 508、`MainLayout` 472 |
| `<el-button>` 总数             | 102                                                                                                                                                                                                                          |
| 显式 `size="small"`            | 81                                                                                                                                                                                                                           |
| **漏写 `size`**                | **21（20.6%）**                                                                                                                                                                                                              |
| `link` / `text` / `plain`      | 11 / 26 / 10                                                                                                                                                                                                                 |
| 纯图标按钮（`circle`/`round`） | 0 —— 因此无需补 `aria-label`（但有 2 处 `<span>` 伪按钮需要，见 §3）                                                                                                                                                         |
| `--ht-*` token                 | 定义 30 / 使用 30，**无「未定义被使用」**；但有 **9 处「已在 :root 定义却仍写死 fallback」**                                                                                                                                 |

> **口径修正**：旧报告写「102 处 el-button 缺 size」不准确，实际漏写 21 处。但把 `el-input`(44)、`el-switch`(12)、`el-radio-group`(**14 处全缺**)、`el-select`(8)、`el-input-number`(6) 等一起算，**其它组件漏写合计 85 处**，才是真正的重灾区 —— 这直接决定了修法（见 §5 R7）。

### 2.2 加载态与防重复提交

| 现状                    | 实测                                                                                                                                                      |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 列表绑定 `v-loading`    | 仅 7 处；`TemplateTab`（建群模板表）、`KnowledgeCard`（文档/草稿列表）、`ConversationListPanel`、`PendingJobsPanel`、`DashboardView` 待审队列**均未绑定** |
| 异步提交按钮 `:loading` | 17 处有；**10 处缺**，其中 4 处是**不可逆动作**（人工发送、审批写入知识库、恢复示例数据、导出 CSV）                                                       |

### 2.3 重复模板

| 重复项                                         | 出现次数                                                                                                                        | 备注                                |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| 卡片头部 `header.ht-card__head`                | 15                                                                                                                              | 含 6 份**逐行相同的 `.spacer` CSS** |
| 空状态占位                                     | **7 套不同实现**（`.empty` ×3、`.mc__empty` ×3、`.inbox__empty`、`.sk__empty`、`.detail__nocomment`、`.create__empty-actions`） | CSS 几乎一致                        |
| `ElMessageBox.confirm(...).catch(() => false)` | 16 处，其中 14 处是**完全相同的样板**                                                                                           |                                     |
| 状态徽章 `tagTypeOf()`                         | 2 份几乎相同的实现（`HistoryTab` / `GroupHistoryTab`）+ 第 3 套 `stateTone`                                                     |                                     |
| 弹窗 footer「取消 / 保存」                     | 5 处，宽高与属性各不相同                                                                                                        |                                     |

### 2.4 布局与滚动

- **三层嵌套滚动**：`MainLayout .canvas{overflow:auto}` → `WeLinkView .tabs__body{max-height:calc(100vh-320px);overflow:auto}` → `.logbox__list{max-height:200px;overflow:auto}`。滚轮行为不可预期，长列表永远够不到页脚。
- 同名 `.tabs__body` 在 `WeLinkView` 与 `GroupView` **样式不一致**（一个有 `padding:14px`，一个没有）。
- 弹窗宽度 5 个不同值（460/480/560/620/—），`label-width` 6 种值。

### 2.5 颜色与 token

- 全项目唯一 `box-shadow`（`WeLinkView .logbox`），与设计规则「hairline 代替阴影」冲突。
- 13 处 `color:#fff`、2 处硬编码 danger 底色（`#f7e9e9`/`#30201f`，恰是 `--el-color-danger-light-9` 的两个主题值）。
- 9 处死 fallback：`var(--ht-border, #dcdfe6)` ×4、`var(--ht-font-mono, ui-monospace, …)` ×5 —— 变量早已在 `:root` 定义，fallback 恒不生效，却让人误以为「这里可能取不到值」。

---

## 3. 缺陷清单（P0–P2）

> 级别口径：**P0 = 影响可用性或数据正确性**（尤指静默失效）；**P1 = 明显一致性/健壮性问题**；**P2 = 打磨项**。

### 3.1 P0（本轮全部修复）

| #   | 缺陷                             | 位置                                                                                                                               | 后果                                           | 处置                                                                                        |
| --- | -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------- |
| U-1 | 建群模板表缺 `v-loading`         | `TemplateTab.vue:139`                                                                                                              | 删/存期间零反馈 → 连点重复提交                 | ✅ 补 `loading` ref + `loadTemplates()` 统一入口                                            |
| U-2 | 人工发送按钮缺 `:loading`        | `HistoryTab.vue:508`                                                                                                               | **真实外发消息**，连点发两遍                   | ✅ 补 `sending`                                                                             |
| U-3 | 审批写入知识库缺 `:loading`      | `KnowledgeCard.vue:362`                                                                                                            | 写 `knowledge/*.md`，连点重复落盘              | ✅ 补 `approving`                                                                           |
| U-4 | 恢复示例数据缺 `:loading`        | `TableCrudView.vue:231`                                                                                                            | **覆盖全表**，连点不可逆                       | ✅ 补 `resetting`                                                                           |
| U-5 | 保存监控会话缺 `:loading`        | `ConfigTab.vue:417`                                                                                                                | 写库，连点两次                                 | ✅ 补 `saving`                                                                              |
| U-6 | 三层嵌套滚动                     | `WeLinkView` / `GroupView`                                                                                                         | 滚轮行为不可预期，够不到页脚                   | ✅ 内层不再自带滚动，交给 `.canvas`                                                         |
| U-7 | 29 处裸 async（有 await 无 try） | `ConfigTab`×5、`HistoryTab`×4、`KnowledgeCard`×4、`InboxTab`×3、`UpdateSettingsCard`×3、`CodehubReviewView`×2、`SettingsView`×3 等 | 写库失败**静默**：开关已动、库没变、用户不知情 | ✅ 新增 `utils/ui-action.ts` 统一出口，本轮收口 13 处高危（§5 R1/R2）；其余 16 处列入下一轮 |

### 3.2 P1（本轮修复 / 部分修复）

| #    | 缺陷                                                    | 位置                                                                     | 处置                                                                                                                                            |
| ---- | ------------------------------------------------------- | ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| U-8  | 106 处组件漏写 `size`（按钮 21 + 其它 85）              | 全局                                                                     | ✅ 由 `ElConfigProvider :size="'small'"` 一次性收口（显式 `size` 优先，81 处既有的无需改）                                                      |
| U-9  | `link` 与 `text` 混用                                   | `TemplateTab`/`KnowledgeCard`/`GroupHistoryTab`/`SkillsSection` 共 11 处 | ✅ 统一为 `text`（`link` 是 EP 早期语义，与 `text` 重复）                                                                                       |
| U-10 | 统计条写死「被拦 **m** 条」                             | `HistoryTab.vue:284`                                                     | ✅ 改为「已拦截」（值是 `{{ stats.skippedCount }}`，标签里的 `m` 是手误残留）                                                                   |
| U-11 | 探测用**草稿密钥**未注册进脱敏表                        | `stores/welink/data.ts:177/190`                                          | ✅ 就地 `registerSecret` + 双侧反证用例。`agent-http` 会把响应体前 200 字拼进 `AgentError`，网关 4xx 回显请求信息时密钥会进日志与 UI 运行日志区 |
| U-12 | 硬编码语义色 `#f7e9e9`/`#30201f`                        | `TableCrudView.vue:482/487`                                              | ✅ 改 `var(--el-color-danger-light-9)`（两个主题各有一份真值）                                                                                  |
| U-13 | 13 处 `color:#fff`                                      | 7 个文件                                                                 | ✅ 收成新 token `--ht-on-accent`                                                                                                                |
| U-14 | 9 处死 fallback                                         | 5 个文件                                                                 | ✅ 清除，回到单一真值                                                                                                                           |
| U-15 | 唯一 `box-shadow` 违反「hairline 代替阴影」             | `WeLinkView.vue:528`                                                     | ✅ 移除                                                                                                                                         |
| U-16 | 弹窗缺 `destroy-on-close` / `close-on-click-modal` 不一 | 5 个弹窗                                                                 | ✅ 本轮 3 个补齐（`ConfigTab`×2、`HistoryTab`、`TemplateTab`）                                                                                  |
| U-17 | 次要动作滥用 `type="primary"`（对称操作视觉权重不对称） | `ConfigTab.vue:291/298-299`                                              | ✅ 「同步会话」「批量开自动回复」降为 `plain`                                                                                                   |
| U-18 | 对象式 `ElMessage({...})` 与简写式混用                  | `TableCrudView`×4、`SettingsView`×2                                      | ✅ 本轮统一 `TableCrudView` 4 处；`SettingsView` 列入下一轮                                                                                     |
| U-19 | 可点击 `<div>`/`<span>` 伪按钮无 `role`/`tabindex`      | `InboxTab.vue:194`、`ConversationListPanel.vue:120/156`                  | ⏭ 下一轮（改 `<button>` + `aria-label`）                                                                                                        |
| U-20 | 表单/筛选控件缺 `aria-label`                            | `TableCrudView:214`、`ConfigTab:282`、`InboxTab:157`、`TraceTab:187`     | ✅ 本轮补 `ConfigTab` 1 处，其余下一轮                                                                                                          |

### 3.3 P2（未做，列入路线图）

| #    | 缺陷                                                                     | 备注                                                              |
| ---- | ------------------------------------------------------------------------ | ----------------------------------------------------------------- |
| U-21 | 空状态 7 套实现                                                          | 抽 `<EmptyState>` + 全局 `.ht-empty`；改动面大，需与 §6 S7 一起做 |
| U-22 | 卡片头部 15 处 + `.spacer` CSS 6 份                                      | 抽 `<CardPanel>`；`.spacer` 先移入全局样式                        |
| U-23 | `confirm(...)` 样板 16 处                                                | 抽 `confirmDanger()`                                              |
| U-24 | 状态徽章 3 套 `tagTypeOf`                                                | 抽 `<StatusTag>`（已有 `MrStateBadge` 可作参照）                  |
| U-25 | 弹窗宽度 5 值 / `label-width` 6 值                                       | 各定 3 档                                                         |
| U-26 | 防抖常量 `300` 硬编码 6 处                                               | 提常量                                                            |
| U-27 | `!` 非空断言 4 处（`CodehubReviewView:267/270`、`EnvCheckView:102/105`） | 改可选链 + fallback，未知状态否则渲染空白                         |
| U-28 | `components/icons.ts`（216 行）零 spec                                   | 补快照 spec                                                       |
| U-29 | `CodehubReviewView.vue:761` 疑似残留空态 CSS                             | 随 U-21 一并确认                                                  |

---

## 4. 架构层剩余缺口

### 4.1 测试覆盖

| 项                                   | 实测                                                                                                                                   |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| 无同名 spec 的 `.ts` 模块            | 40 个（>80 行 20 个），其中经契约/集成 spec **实质已覆盖** 37 个                                                                       |
| **真正零覆盖**                       | `components/icons.ts`（216 行）、`infra/rag/port.ts`（`RagError` 三态 `kind` 决定 UI 报错文案与留痕分类，无任何 spec 引用）、`main.ts` |
| **最大未测装配点**                   | `stores/welink/index.ts`（377 行）—— 组件 spec 全部 `vi.mock` 掉它，仅 `facade.spec.ts` 真跑一次                                       |
| `as any` / `@ts-ignore` / 空 `catch` | **0 / 0 / 0**（生产代码库极干净）                                                                                                      |
| 非空断言 `!`                         | 4（生产代码）                                                                                                                          |

### 4.2 大文件（S5 候选，19 个非 spec 文件 >400 行）

拆分优先级（**先拆有 spec 的**，铁律：先补测试再拆）：

1. `infra/db/repos/welink.ts`（939）+ `welink-memory.ts`（709）—— 契约 spec 已就绪，可安全回归
2. `orchestrator/pipeline.ts`（844，有 spec，已按 generate/send/retry 分区）
3. `views/CodehubReviewView.vue`（815，有 spec，脚本占 700 行应下沉 store）
4. `orchestrator/safety-gate.ts`（717）、`knowledge-harvester.ts`（618）、`poller.ts`（462）
5. **最后**处理 4 个无 spec 的大组件（`HistoryTab` 689 / `ConfigTab` 633 / `TraceTab` 621 / `InboxTab` 608）—— 先补 spec 再动刀

### 4.3 假设标签与未核实面

| 标签           | 数量 | 可否关闭                                                                          |
| -------------- | ---- | --------------------------------------------------------------------------------- |
| `[CLI-ASSUME]` | 38   | ❌ CLI 未对接，仍是最大未核实面                                                   |
| `[RAG-ASSUME]` | 8    | ❌ RAG 服务未对接                                                                 |
| `[WIN-ASSUME]` | 6    | 部分可关（`registry.ts:70,95` 的 `where`/`nslookup` 参数语法属 Windows 确定行为） |
| `[UPD-ASSUME]` | 5    | 2 处可关（U-1 / U-3 已于 2026-10-11 PoC 实测通过）                                |
| `[LLM-ASSUME]` | 1    | ✅ 已于 2026-10-04 逐项核实，标签仅作记录                                         |
| `[MOCK-*]`     | 60   | 永久设计标记（切换点说明），保留                                                  |

⚠️ **发布前必须先做的两件事**（不属于本轮，但必须写进清单）：

1. `src/infra/update/key.ts:4` 的**公钥是 2026-10-11 PoC 一次性密钥对** —— 不轮换则任何人可伪造更新清单。
2. `stores/app.ts:105` 整包 `JSON.stringify(settings)` 落盘，**三把密钥（`agent.apiKey` / `rag.apiKey` / `codeHub.token`）仍明文**（N4 未做，待拍板，见 §6 Q1）。

### 4.4 性能

| 点                                                                      | 判定                                     | 建议                                                               |
| ----------------------------------------------------------------------- | ---------------------------------------- | ------------------------------------------------------------------ |
| `sediment.ts:126-144` `applyAnnouncements` 循环内 3 次 `await bridge.*` | **真 N+1**（N 条公告 = 3N 次跨进程 IPC） | 改批量：`IN (...)` 一次取会话 id + 批量 INSERT + 一次回查 ⏭ 下一轮 |
| `bootstrap.ts:114` 逐会话 `hasOutgoingReceipt`                          | 有界（仅崩溃残留任务，通常 0–3 条）      | 不动                                                               |
| `knowledge-harvester.ts:445` 逐会话拉公告                               | 有界（配置会话数 + 单轮限量）            | 上一轮已做轮内缓存，不动                                           |
| 17 处 deep watch                                                        | **全部经 300ms 防抖**（无裸 deep watch） | 只提常量（U-26）                                                   |
| 唯一 `setInterval`（`host-link.ts:90`）                                 | 已正确清理                               | 不动                                                               |

---

## 5. 本轮落地（10 组）

| #       | 内容                                                                                                        | 文件                                                     | 反证                                     |
| ------- | ----------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- | ---------------------------------------- |
| **R1**  | 新增 `utils/ui-action.ts`：`errorText()` + `runUiAction()`，契约 = 「失败必提示 + busy 必复位 + 返回布尔」  | `src/utils/ui-action.ts`、`ui-action.spec.ts`（11 用例） | 去掉 `ElMessage.error` → 3 条用例变红 ✅ |
| **R2**  | `ConfigTab` 5 处裸 async 收口；**开关类失败必重拉**（把界面回滚到库里真值）；删除前读条数失败即中止         | `components/welink/ConfigTab.vue`                        | —                                        |
| **R3**  | `HistoryTab` 4 处裸 async 收口；区分「抛错」与「业务拒绝」两层失败                                          | `components/welink/HistoryTab.vue`                       | —                                        |
| **R4**  | `KnowledgeCard` 4 处裸 async 收口（下架 / 拒绝 / 保存 / 审批写入）                                          | `components/welink/KnowledgeCard.vue`                    | —                                        |
| **R5**  | `TemplateTab` 补 `v-loading` + 新增 `loadTemplates()` 统一入口（含失败提示）                                | `components/group/TemplateTab.vue`                       | —                                        |
| **R6**  | `TableCrudView` 导出/恢复补 `:loading` + 接住抛错 + 尺寸收口                                                | `views/TableCrudView.vue`                                | —                                        |
| **R7**  | 全局 `ElConfigProvider :size="'small'"` —— 一次性收口 106 处漏写；`link`→`text`（11 处）                    | `App.vue` + 4 个组件                                     | —                                        |
| **R8**  | 探测草稿密钥进脱敏表                                                                                        | `stores/welink/data.ts` + `data.spec.ts`                 | 去掉 `registerSecret` → 2 条用例变红 ✅  |
| **R9**  | 颜色/typography token 化：`--ht-on-accent`（13 处）、danger-light-9（2 处）、清 9 处死 fallback、去唯一阴影 | `styles/index.css` + 7 个组件                            | —                                        |
| **R10** | 拆双层滚动 + 统一 `.tabs__body`；弹窗 `destroy-on-close`；次要动作降权；修「被拦 m 条」                     | `views/WeLinkView.vue`、`views/GroupView.vue` 等         | —                                        |

**统一纪律**：新用例先做反证（注入缺陷 → 变红）再提交；禁止 `.skip`/`.only`/放宽断言；不新增任何依赖（R1 的两个函数只用 `element-plus` 与 `vue` 的 `Ref` 类型）。

---

## 6. 路线图（下一轮及以后）

| 编号    | 事项                                                                                                                                                                                                                      | 触发条件                             | 量级 |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ | ---- |
| **S6**  | 裸 async 收口扫尾（剩 16 处：`InboxTab`×3、`UpdateSettingsCard`×3、`SettingsView`×3、`TraceTab`×2、`CodehubReviewView`×2、`GroupView`、`ConversationListPanel`、`PendingJobsPanel`、`SafetySection`、`KnowledgeCard:73`） | 本轮 S3 完成且门禁全绿               | 中   |
| **S7**  | UI 重复模板抽取：`EmptyState` / `CardPanel` / `StatusTag` / `confirmDanger()` / 弹窗与 `label-width` 档位                                                                                                                 | S6 完成                              | 大   |
| **S8**  | 补 `stores/welink/index.ts`（377 行装配根）与 `infra/rag/port.ts`（`RagError` 分类）直连 spec                                                                                                                             | 随时可开                             | 中   |
| **S9**  | 修 `sediment.ts` 3N 次 IPC N+1                                                                                                                                                                                            | 契约 spec 已就绪                     | 小   |
| **S10** | S5 大文件拆分（按 §4.2 顺序，单个 PR 只拆一个文件）                                                                                                                                                                       | S8 完成、目标文件有 spec 且覆盖 ≥85% | 大   |
| **S11** | a11y：伪按钮改 `<button>` + `aria-label`（U-19/U-20 剩余 6 处）                                                                                                                                                           | 随 S7                                | 小   |

### 6.1 需要拍板的问题

| #      | 问题                                     | 选项                                                                                                                                                                                                                      | 建议                                                                                    |
| ------ | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| **Q1** | 密钥明文落盘（N4）                       | A = 宿主 DPAPI 密文存 config.json（新增 1~2 个 Rust 命令 + 扩 `windows-sys` feature，需实测 `npm run pack`；跨机迁移需重填）；B = 不加密，只做暴露面收敛 + 设置页风险提示；C = Credential Manager（脱离数据根，迁移必丢） | **A**（与「数据根可迁移」兼容，只防离线拷贝这一真实风险）。若一个 Rust 命令都不想加 → B |
| **Q2** | 更新公钥轮换                             | 轮换 / 暂缓                                                                                                                                                                                                               | **发版前必须轮换**（当前是 PoC 一次性密钥）                                             |
| **Q3** | 是否给 `utils/ui-action.ts` 落覆盖率阈值 | 落 / 不落                                                                                                                                                                                                                 | 先跑实测值，按「实测 − 3 个百分点」落（AGENTS.md 纪律：先补测试再抬线）                 |

---

## 7. 门禁与验证

| 项                                                                                      | 基线                | 本轮后                           |
| --------------------------------------------------------------------------------------- | ------------------- | -------------------------------- |
| `npm run lint`                                                                          | 0 问题              | **0 问题**                       |
| `npm run typecheck`                                                                     | 0 错误              | **0 错误**                       |
| `npm test`                                                                              | 91 文件 / 1396 用例 | **92 文件 / 1409 用例全绿**      |
| 覆盖率阈值（orchestrator 95/90/95/88、infra/db 72/68/72/68、infra/windows 90/75/90/88） | 全部达标            | 不得回退（本轮按 §4.1 口径核对） |
| 新增依赖                                                                                | —                   | **0**                            |
| Rust 改动                                                                               | —                   | **0**（本轮纯前端）              |
