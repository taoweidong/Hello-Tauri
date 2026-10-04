# welink-cli / codehub-cli 对接真实接口适配指南（2026-10-04）

> **本文档的用途**：真实 CLI 接口文档到手后，对接工作的人（或 agent）按本文档的核对表
> 逐项核实假设、在指定改动面内完成适配，**不需要重新读一遍全部源码**。
> 假设清单的机器可读来源是源码内标签：`grep -rn "MOCK-CLI\|CLI-ASSUME" src/`；
> 本文档是它们的**结构化汇总 + 对接 SOP**，两者以源码标签为准、本文档维护索引。

---

## 1. 底座现状：为什么对接只需要改少数文件

整条链路是「Port 接口 + 双实现（mock / cli）」的打桩先行结构，真实 CLI 文档到手后
**只换适配器文件，上层（stores / orchestrator / views）零改动**：

```
views / components
      │  （UI 层禁止直触 infra，ESLint 闸门强制）
stores  ──► orchestrator（轮询 / 管线 / 安全闸 / 建群流程 / CodeHub 同步与补拉）
      │
      ▼
infra Port 接口（变化点边界，对接时不动）
  ├── welink:  WelinkPort + GroupPort   mock.ts / group-mock.ts  ◄──┐
  │            welink-cli.ts + commands.ts + adapter.ts + exec.ts ──┤ 切换点
  ├── codehub: CodeHubPort              mock.ts ◄──────────────────┤ index.ts
  │            codehub-cli.ts + exec.ts ────────────────────────────┘ (welinkClient /
  └── envcheck: welink 探测器（doctor）                                  codeHubPort)
      │
      ▼
bridge.cliRun（Rust 通用 CLI 通道）──► 子进程 welink-cli.exe / codehub-cli.exe
```

### 1.1 数据源切换与兜底（`infra/*/index.ts`）

| 配置 | 真实入口 | 兜底行为 |
| ---- | -------- | -------- |
| `WelinkSettings.welinkSource = 'cli'` + `cliPath` | `welinkClient()` → `createCliWelinkPort` / `groupClient()` → `createCliGroupPort` | 浏览器模式强制 mock；桌面选 cli 但 cliPath 为空 → 回退 mock + warn 日志 |
| `CodeHubSettings.source = 'cli'` + `cliPath` + `token` | `codeHubPort()` → `createCliCodeHubPort` | 同上两条兜底 |

对接当天只需要：配置页把数据源切到 `cli`、填好 exe 路径（CodeHub 另需 token），
**切换点文件本身不用改**。

### 1.2 Rust 侧（不用动）

`src-tauri/src/cli.rs` 的白名单 `ALLOWED_STEMS` **已含** `welink-cli` 与 `codehub-cli`；
通道机制对接无关且不可绕过：

- 参数以**数组**传递、不经 shell（无注入面）；
- stdout/stderr 各截断 **2MB**（`MAX_OUTPUT`），超时默认 **15s**（TS 侧显式传更短预算）；
- 输出 base64 回传，TS 侧解码链：**UTF-8 严格 → GBK 兜底 → lossy**（`src/utils/b64.ts`）。

新增别的 exe 才需要动 Rust；对接这两个 CLI 不需要。

---

## 2. 对接时必须守住的不变式（红线）

适配器怎么改都可以，但以下端口语义是上层编排的依赖前提，**破坏任何一条都要先改设计**：

| # | 不变式 | 依赖方 |
| - | ------ | ------ |
| 1 | `pull` 的 `cursor` 对业务**不透明**：实现方定语义，调用方只回传；`limit` 强制生效；`hasMore=true` 时编排层同事务续批（≤3 次） | `orchestrator/poller.ts` |
| 2 | `send` 返回的 `msgUid` 是**防双发幂等键**；发送**不做传输层重试**（重试=可能双发） | 外发 worker、回执核对（设计 §6.2） |
| 3 | 消息缺稳定 UID 是 `parse` **硬错误**（不能静默生成，会重复回复） | 管线去重 |
| 4 | 建群**绝不能自动重试**；外呼前先落 `pending` 留痕，终态以 `WHERE status='pending'` 原子回写 | `orchestrator/group.ts`（migration v3 铁律） |
| 5 | `verifyConnection` **永不 reject**（诊断通道，失败原因装进结果返回） | CodeHub 配置页 |
| 6 | `listMergeRequests` 返回 `{records, degraded}`：`degraded=true` 必须如实上报（本轮可能不完整），编排层写进同步摘要，**不写** `last_error` | `orchestrator/codehub-sync.ts`（design D5） |
| 7 | `getMergeRequestDetail` 恒返回非空详情（拿不到就是 `parse`） | `orchestrator/codehub-detail.ts`（点开补拉、在飞去重） |
| 8 | 错误三分类：`transport` 可重试 1 次 / `parse` 重试无意义 / `auth` 引导用户改配置 | 各 exec + 编排层退避策略 |
| 9 | P8 载荷可控：批上限 200（welink `MAX_BATCH` / codehub `CODEHUB_MAX_BATCH`），2MB 输出截断 | 所有轮询/同步 |
| 10 | 脱敏：错误信息里 `--text`（草稿正文）与 `--token` 只留长度（`redactArgs` / `redactToken`） | 日志与 `last_error` 不外泄 |
| 11 | CodeHub 域**纯只读**：不接 safety-gate、无任何外发 | AGENTS.md 铁律 |
| 12 | WeLink 回复铁律不受对接影响：草稿先落库置 `ready` 才外发，外发前过 `safety-gate` | AGENTS.md 铁律 |

---

## 3. welink-cli 假设清单（`[CLI-ASSUME]` 逐项核对表）

> 改动面：`src/infra/welink/commands.ts`（子命令/参数）+ `adapter.ts`（输出归一化），
> `exec.ts` 是通用机制（只有编码/错误分类可能微调）。核对完一项就更新/删除源码里
> 对应标签，并把「核实动作」列改成结论。

### 3.1 子命令面（第一核对点：`commands.ts`）

| # | 假设 | 假设的完整形态 | 核实动作 | 核实后 |
| - | ---- | -------------- | -------- | ------ |
| W1 | `list` 拉会话候选 | `welink-cli list --json` | 核对子命令名与参数拼写；不一致只改 `SUBCOMMANDS` + `listArgs()` | ☐ |
| W2 | `pull` 增量拉消息 | `pull --conv <id> --type <group\|private> --limit <n> [--after <cursor>] --json`；`after` 空串时**省略**（首拉取最新一批） | 核对参数名（--conv/--type/--after/--limit）与「首拉」语义；注意 `--type` 取值域是否就是 `group/private` | ☐ |
| W3 | `send` 发文本 | `send --conv <id> --type <t> --text <t> --json` | 核对参数名；确认超长文本上限（外层 S6 maxDraftChars=500 兜底） | ☐ |
| W4 | `create-group` 快速建群 | `create-group --name <群名> --members <id1,id2,…> --json`（成员半角逗号串） | **优先核实**：参数名、成员串格式（是否支持逗号串/要不要逐个传）、返回 JSON 形状、退出码语义、是否总能回传群 ID。建群不可自动重试，参数错了会建出错误群组 | ☐ |
| W5 | `doctor` 环境自检 | `doctor --json` → `{ ok: boolean, problems?: string[] }` | 核实命令名与返回形状；**若 CLI 没有自检命令**：探测器已把该步降级 warn（基础可用性由 `--version` 判定），改 `SUBCOMMANDS.doctor` 或移除该步 | ☐ |
| W6 | `--version` 可执行检查 | 退出码 0 + 首行含版本 | 基本必支持；核实输出格式 | ☐ |
| W7 | `--help` 试跑 | Settings「试跑」按钮 | 若不支持 --help，改 `helpArgs()` | ☐ |
| W8 | 所有子命令都带 `--json` | 文本格式解析脆弱，JSON 至少能报「结构不符」 | 核实 JSON 输出开关的真实写法（`--json` / `--format json` / 默认即 JSON） | ☐ |

### 3.2 输出归一化（`adapter.ts`，「宽进」候选字段清单 = 假设面）

> 原则：**宽进严出**——字段名容错，但缺关键字段抛 `parse`。对接后按真实输出
> **收窄候选清单**（假设面越窄越安全，过度宽容会掩盖字段缺失）。

| # | 解析点 | 候选（当前全部为假设） | 核实动作 | 核实后 |
| - | ------ | ---------------------- | -------- | ------ |
| W9 | `pull` 容器 | `{messages\|items\|list\|data, cursor\|nextCursor\|next\|lastCursor, hasMore\|has_more\|more}` 或裸数组 | 用真实样本定形；`cursor`/`hasMore` 缺失时走兜底（见 W16） | ☐ |
| W10 | 消息 UID | `msgUid/msg_uid/msgId/msg_id/id/uuid`；**缺失=parse 硬错误** | 确认真实 UID 字段名与稳定性（同一条消息重拉 UID 不变，幂等去重依赖） | ☐ |
| W11 | 发送者 | `senderId/sender_id/fromId/from/sender`；`senderName/sender_name/fromName/nickname` | 确认字段名 + 工号形态（与 `myUserId` 比对判定自发消息） | ☐ |
| W12 | @我 识别 | 显式 `atMe/at_me/mentioned`；或列表 `atList/at_list/mentions/atUsers`（元素可为串或 `{id/userId/empNo}`）；`atAll/at_all/mentionAll` 压制（Q5：@所有人不算@我） | 确认 CLI 给哪种形状；**这是自动回复触发（R3 group_at_me）的依据，必须核实** | ☐ |
| W13 | 内容与类型 | `content/text/body`；`msgType/msg_type/type`（默认 text）；非 text 占位存档：`[图片][文件][语音][视频][系统消息][位置]` | 确认 msgType 取值全集；占位映射按真实类型补 | ☐ |
| W14 | 时间 | `sentAt/sent_at/timestamp/time/createTime`；ISO / 10 位秒 / 13 位毫秒 → 归一为 `YYYY-MM-DD HH:mm:ss` 本地串 | 确认格式与**时区**（本地时间还是 UTC）；归一函数 `normalizeTime` 已兜三种，异常格式会静默落到当前时间——需实测确认 | ☐ |
| W15 | `list` 输出 | 容器 `conversations/groups/contacts/items/list` 或裸数组；字段 `convType/conv_type/type`（private\|group）、`convId/conv_id/id/empNo/groupId`、`title/name/nickname`、`unreadCount/unread` | 用真实样本定形；list 只用于监控配置导入（R1），字段缺失不致命但影响可用性 | ☐ |
| W16 | `pull` 游标兜底 | CLI **没回传游标**时：`ts:<最后一条消息时间>` 兜底；空批保持原游标（宁可少拉不重复拉全量） | 若 CLI 有原生游标，**直接用 CLI 的**（删兜底逻辑）；若语义是「按时间拉取」，确认 `ts:` 兜底与其兼容 | ☐ |
| W17 | `send` 回执 | `msgUid/msg_uid/msgId/msg_id/id`；缺失时派生 `local-<seed>`（幂等键稳定） | 确认回执字段；**真实 UID 与本地派生不能混用**（回执核对依赖） | ☐ |
| W18 | `create-group` 回执 | `groupId/group_id/convId/conv_id/chatId/id`；缺失**不报错**、派生 `local-<seed>` 占位（UI 提示人工核对，防「已建成」被记成失败） | 确认是否总能回传群 ID；若退出码非 0 也可能已建群，需把该语义写进 `orchestrator/group.ts` 的留痕说明 | ☐ |

### 3.3 通道与分类（`exec.ts`）

| # | 假设 | 现状 | 核实动作 | 核实后 |
| - | ---- | ---- | -------- | ------ |
| W19 | 输出编码 UTF-8 | 严格解码失败退 GBK（`src/utils/b64.ts`） | 实测中文输出编码；异常时改解码链，不在业务侧特判 | ☐ |
| W20 | 非 0 退出码 → `parse` | welink 侧**没有 auth 分类**（codehub 有）：登录态失效、token 过期等都会被归为 parse | **开放点**：确认「未登录」的表现形式（退出码/错误文案）；若需要与参数错误区分，参照 `codehub/exec.ts` 的 `AUTH_PATTERN` 给 welink 补 auth 分类（`WelinkError` 的 `auth` kind 已预留） | ☐ |
| W21 | 传输故障重试 1 次 | `withTransportRetry`；`send` 与 `create-group` **不重试** | 确认 list/pull 幂等（重拉 1 次无损）后维持；send/建群保持不重试 | ☐ |
| W22 | 超时预算 12s | Rust 15s 兜底，welink 侧显式 12s | 按真实 CLI 冷启动/响应耗时调整 | ☐ |
| W23 | `--text` 脱敏 | 错误信息只留长度（`redactArgs`） | 无需核实 CLI，属本侧约束；新增敏感参数时同步登记 | ☐ |

---

## 4. codehub-cli 假设清单（吸收自归档清单 `2026-10-04-personal-workbench/cli-assume-checklist.md`）

> 改动面：`src/infra/codehub/codehub-cli.ts`（参数拼装 + 归一化）+ `exec.ts`（token/分类）。
> 锚点用**符号名**（行号会漂移）；假设清单的文件头版本见 `codehub-cli.ts` 顶部框注。

| # | 假设 | 假设内容（候选清单） | 核实动作 | 核实后 |
| - | ---- | -------------------- | -------- | ------ |
| C1 | 子命令面 | 连通自检 `auth status`（退出码 0 即可用）；列表 `mr list --repo <id> [--state <s>] --limit <n> --format json`；单条 `mr view <iid> --repo <id> --format json` | 用 `--help` 逐个确认；不一致只改 `listArgs` / `viewArgs` / `verifyConnection` | ☐ |
| C2 | token 注入 | 全局参数 `--token <值>` 置于子命令**之前**（`exec.ts` `TOKEN_FLAG`；用户已确认参数方式，参数名待核实） | 核实参数名与位置；若只认环境变量，改 `exec.ts` 注入方式并同步 `CodehubSettingsCard.vue` 提示文案；脱敏 `redactToken` 随注入方式一起调整 | ☐ |
| C3 | 输出形态 | UTF-8 文本；`list` 回 JSON **数组**、`view` 回 JSON **单对象** | 实测两个子命令；GBK/带 BOM 时接 `utils/b64.ts` 兜底 | ☐ |
| C4 | 状态归一 `normalizeState` | 源字段 `state/status`；`opened/open→open`、`merged→merged`、`closed/rejected→closed`，其余 parse | 取真实状态全集补进/收窄；注意是否有 drafting 等中间态 | ☐ |
| C5 | 列表字段 `normalizeRecord` | `iid/mr_iid/number/id`、`title`、`author/author_name/username`、`source_branch/sourceBranch`、`target_branch/targetBranch`、`updated_at/updatedAt`、`web_url/webUrl/html_url`；`iid`/`title` 缺失 = parse | 用真实 JSON 样本核对后**删掉多余候选** | ☐ |
| C6 | 检视摘要 `normalizeReview` | `reviewers`（字符串或 `{name/username/id}` 数组）、`approvals/approve_count`、`unresolved_comments/unresolved`、`last_activity_at/updated_at`；缺失回落 0/空，不丢整条记录 | 确认 list 输出是否携带摘要；若只在 view 里才有，把摘要改由详情补拉填充（需同步 `codehub-detail.ts`） | ☐ |
| C7 | 评论字段 `normalizeComments` | `comments[]` 元素含 `author/username/name`、`body/content`、`created_at/createdAt`；**字段缺失**＝详情不可得（触发点开补拉）、**空数组**＝合法「确实没有评论」——两者语义不同，收窄时不得合并 | 确认 list 是否带 comments；若恒不带，「点开补拉」会变成每次浏览的必经调用，UI 需另行提示 | ☐ |
| C8 | 截断降级（design D5） | 宿主 2MB 截断把 `list` 腰斩时：按花括号深度抢救完整元素入库、残缺丢弃、`degraded=true` 上报（`parseMrArray`）；非截断的非法输出直接 parse | 确认真实 CLI 是否自带分页/上限从而不会触到截断；若 CLI 有游标分页，可考虑引入增量（见 §7 开放点） | ☐ |
| C9 | 认证失败识别 | `exec.ts` `AUTH_PATTERN`：`/auth\|token\|unauthorized\|401\|403\|credential\|login\|permission/i` 命中 → `auth` 错（引导改配置），否则非 0 → parse | 用真实错误文案核实/补充模式；保证「认证失败」与「通道故障」（后者才退避重试）可区分 | ☐ |
| C10 | repoId 形态与 limit 上限 | repoId 按「空间/仓库」路径式假设（`types/codehub.ts`）；`--limit` 服务端上限未知 → 本地 `CODEHUB_MAX_BATCH=200` 钳制 | 核实 repoId 真实形态（影响仓库注册 UI 与快照主键）；上限确认后与 200 取小并更新配置页批上限提示 | ☐ |

---

## 5. 数据模拟现状（`[MOCK-CLI]` 替身：对接后**保留**）

mock 的双重身份：**单测替身**（与真实实现共享端口契约测试）+ **浏览器调试数据源**
（`npm run dev` 无 Rust 环境全链路可演示）。对接真实 CLI 后不删、不改接口，继续用。

### 5.1 welink 消息 mock（`src/infra/welink/mock.ts`）

| 能力 | 说明 |
| ---- | ---- |
| 会话候选 | `MOCK_CONVERSATIONS` 固定 5 条（3 群 + 2 私聊，convId/工号虚构） |
| 消息池 | 每批含 **@我（群）/ 普通私聊 / 自发（out）** 三类样本；**第 2 批起轮换出现图片样本**（`[图片]` 占位存档链路可演示，不触发回复） |
| 演示剧本 O13 | `DEMO_SCRIPT` 三段「新人群@我 → 私聊追问（含一条图片）→ 对方回应」，`playScript()` 一键回放 |
| 游标 | `mock:<convId>:<批次>` 前缀，`after` 不参与语义（真实游标语义由 CLI 决定，对业务不透明） |
| 回执 | `mock-out-<convId>-<序号>` 本地编号，发送记账 `sentMessages`（回执核对演示） |
| 故障注入 | `failNextPull(n)` / `sendFailures` / `pullFailures` **确定性**抛 transport（测试退避/防双发） |
| 时钟 | 逻辑时钟推进（`advance`），非真实时钟，便于断言 |

### 5.2 建群 mock（`group-mock.ts`）

立即成功（可配 `latencyMs`），群 ID `mock-g-<序号>` 本地编号；`failNextCreate(n)` 确定性抛
transport（失败留痕路径测试）。真实侧差异：耗时以 CLI 实测为准、群 ID 以 CLI 回传为准、
**不可自动重试**。

### 5.3 环境检测 mock（`envcheck/mock.ts`）

浏览器模式返回固定结论（welink-cli / Python 均可用，标注「模拟」）；桌面模式执行真实探测
（welink 探测器两步：`--version` 判可用 → `doctor` 自检允许缺席降级 warn）。

### 5.4 CodeHub mock（`src/infra/codehub/mock.ts`）

| 能力 | 说明 |
| ---- | ---- |
| 仓库夹具 | `MOCK_REPOS` 3 个（`demo/*` 路径形态虚构） |
| MR 夹具 | `MOCK_MRS` 7 条，**三状态 × 三仓库全覆盖**；其中 1 条 `detail: null`（详情弃写路径替身，view 侧另有载荷 `MOCK_MR_DETAILS` →「点开补拉」浏览器可演示） |
| degraded 注入 | `injectDegraded(n)` / 配置项 `degradedCount`：接下来 N 次 list 返回 `degraded=true`（检视页「数据可能不完整」降级条与同步摘要告警的演示通道）；不注入时恒 false |
| 故障注入 | `injectTransportFailure` / `injectParseFailure`（配置项 `transportFailures`/`parseFailures`），按次消费，作用于 list / view / verifyConnection 全通道 |
| 语义差异 | `verifyConnection` 恒可用；无游标/增量（每轮全量重拉，与本期真实侧假设一致，见 §7 开放点） |

### 5.5 契约测试（mock 与真实适配器共用的行为基准）

| 文件 | 钉住什么 |
| ---- | -------- |
| `src/infra/welink/ports.spec.ts` | adapter「宽进严出」全部分支（候选字段、@我、时间、占位）+ mock 端口契约 |
| `src/infra/welink/welink-cli.spec.ts` | 真实适配器编排职责（参数组装、批钳制、游标兜底、send 不重试） |
| `src/infra/welink/group-ports.spec.ts` | 建群端口契约（留痕、占位 ID、不重试） |
| `src/infra/codehub/codehub-cli.spec.ts` | 真实适配器分类/降级语义；**`LIST_JSON` 夹具 = 字段假设的镜像**，对接时用它装真实样本 |
| `src/infra/codehub/ports.spec.ts` | mock 端口契约（过滤、详情分工、故障/degraded 注入） |

> **对接时更新夹具**：把真实 CLI 的输出样本（脱敏后）替换进上面两个「形状夹具」
> （welink 的在 `ports.spec.ts` adapter 段，codehub 的在 `codehub-cli.spec.ts` 头部），
> 契约测试就从「钉假设」变成「钉真实契约」。

---

## 6. 对接 SOP（拿到真实接口文档后的操作顺序）

1. **定位全部假设**：`grep -rn "MOCK-CLI\|CLI-ASSUME" src/`，对照本文档 §3/§4 表格；
2. **逐项核实**：用 `--help` / 真实命令试跑确认子命令面（W1–W8 / C1–C3），
   再用真实输出样本核对归一化清单（W9–W18 / C4–C7）；
3. **改适配器**（只动这些文件）：
   - welink：`commands.ts`（子命令/参数）→ `adapter.ts`（收窄候选字段）→ 需要时 `exec.ts`（编码/错误分类）；
   - codehub：`codehub-cli.ts` → 需要时 `exec.ts`（token 注入/AUTH_PATTERN）；
4. **更新契约夹具**（§5.5），让测试钉住真实样本；`envcheck/welink.ts` 的 doctor 形状如有变化同步；
5. **全量回归**：`npm run check`（lint + typecheck + test）必须全绿；
6. **桌面实测**：`npm run tauri:dev`，配置页切 `source='cli'` 填路径，观察：
   轮询日志与游标推进、`last_error` 是否为空、CodeHub 同步摘要与降级条、
   发送回执核对、建群留痕终态；
7. **收尾**：核实一项就更新/删除对应 `[CLI-ASSUME]` 标签并把本文档表格「核实后」打勾写结论；
   `[MOCK-CLI]` 替身**保留**；若确认了 §7 的开放点，回写本文档并同步相关设计文档
   （`design-welink-agent-2026-09-27.md` / 归档变更的 design.md）。

**不要做的事**：不动 Rust（白名单已含两个 CLI）；不动 `infra/*/index.ts` 切换点与
`port.ts`（除非端口语义本身要变，那需要先改设计）；不动 orchestrator/stores；
不删 mock。

---

## 7. 开放点（文档预设不了、必须实测后决策）

| # | 问题 | 影响面 |
| - | ---- | ------ |
| O1 | welink-cli「未登录/凭据失效」如何表现？要不要给 welink 补 `auth` 错误分类（codehub 已有） | `welink/exec.ts`、轮询退避策略 |
| O2 | codehub-cli 是否有游标/增量语义？若有，每轮全量重拉（`CODEHUB_MAX_BATCH=200`）是否要升级为增量 | `codehub-sync.ts`、`types/codehub.ts` |
| O3 | welink-cli `doctor` 是否存在及返回形状 | `envcheck/welink.ts`（已做缺席降级 warn） |
| O4 | `create-group` 是否总能回传群 ID、退出码语义（0 = 必然建成？） | `group-cli.ts`、`adapter.ts`、建群留痕 |
| O5 | 时间字段的时区（CLI 本地时间 vs UTC）——`normalizeTime` 现按本地时间归一 | 存档时间、轮询游标兜底 |
| O6 | CLI 冷启动耗时 → 超时预算（12s）与轮询周期是否匹配 | `welink-cli.ts`/`codehub-cli.ts` timeoutMs、settings |

## 8. 关联文档与命令速查

- 总设计：`docs/design-welink-agent-2026-09-27.md`（架构 §3、数据模型 §4、安全闸 §5A、建群 §15）
- CodeHub 规格：`openspec/specs/codehub-review/spec.md`；设计决策 D3/D5/D6 在
  `openspec/changes/archive/2026-10-04-personal-workbench/design.md`（C8 截断降级即 D5）
- 大模型侧同款约定：`[LLM-ASSUME]`，见 `grep -rn "LLM-ASSUME" src/` 与
  `docs/design-llm-connection-2026-10-02.md`（对接真实大模型服务时另行核对）
- 标签盘点：`grep -rn "MOCK-CLI\|CLI-ASSUME" src/`
- 验证：`npm test`（单测）/ `npm run check`（lint+typecheck+test）/ `npm run verify`（全量）
