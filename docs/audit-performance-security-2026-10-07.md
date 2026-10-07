# 性能与安全审查报告

- **审查对象**：Hello-Tauri（`br_builder` 分支，Tauri 2 + Vue 3 + TS 的 Windows 单文件离线桌面应用）
- **审查日期**：2026-10-07
- **审查范围**：`src-tauri/src/**`（11 个 .rs）、`src/**`（217 个文件，含 infra / orchestrator / stores / views / components / repositories / utils / types）、`scripts/**`、构建配置（vite / vitest / eslint / tsconfig / tauri.conf.json / capabilities / Cargo.toml）
- **代码规模**：约 2.15 万行（含测试）
- **审查方式**：分四域并行深读→ 关键结论逐条打开源码复核行号 → 高危结论以可执行实验实测验证
- **本次未改动任何代码**（按要求）

## 结论摘要

| 维度 | 高  | 中  | 低  | 说明                                      |
| ---- | --- | --- | --- | ----------------------------------------- |
| 安全 | 3   | 6   | 7   | 含 1 项已在真实 SQLite 上复现的数据缺陷   |
| 性能 | 2   | 8   | 6   | 集中在 N+1 查询、全表拷贝、定时器生命周期 |

**最需要立刻处理的三件事**：

1. **保留期清理 100% 静默失效**（S-P1）—— 已用`node:sqlite` 实测复现 `FOREIGN KEY constraint failed`，消息表一条都删不掉，且被 `Promise.all` + `.catch` 吞成一条 warn。现有单测因全mock bridge 只断言 SQL 文本，永远发现不了。
2. **CLI 白名单只比主干名、不校验扩展名**（S-01）—— `python.bat` / `python.cmd` / `python.ps1` 全部放行，批处理经 `CreateProcess` 由 `cmd.exe` 解释执行。
3. **保留期清理器一次"停止"后永久停摆**（P-01）—— `stop()` 置 `disposed=true` 且无复位入口，用户关一次总开关，清理器此进程内再也不会启动。

**总体评价**：本项目的安全基线**明显高于同规模项目平均水平**——SQL 全参数化、无任何注入点、零 `v-html`/`innerHTML`、双层命令白名单、符号链接逃逸防护、日志脱敏机制、CSP 无 `unsafe-eval`。问题集中在**少数几个"防护做了但没收口"的位置**（约束写在注释里而非代码里、白名单只做了一半），以及**测试全mock 导致 SQL 语义类缺陷不可见**这一元问题。

---

## 一、优先级总览

| ID   | 问题                                                      | 维度        | 严重度 | 位置                                           | 优先级 |
| ---- | --------------------------------------------------------- | ----------- | ------ | ---------------------------------------------- | ------ |
| S-P1 | 保留期清理必然抛外键错误，静默失效                        | 安全/数据   | 高     | `src/infra/db/repos/welink.ts:861`             | **P0** |
| S-01 | CLI 白名单不校验扩展名，`.bat/.cmd/.ps1` 放行             | 安全        | 高     | `src-tauri/src/cli.rs:81`                      | **P0** |
| P-01 | `retention.stop()` 后永久失效，无复位入口                 | 性能        | 高     | `src/orchestrator/retention.ts:170`            | **P0** |
| S-02 | 建群外呼完全绕过 safety-gate                              | 安全        | 高     | `src/orchestrator/group.ts:52`                 | **P1** |
| S-03 | RAG/知识库内容进提示词未消毒（多跳注入链）                | 安全        | 中高   | `src/infra/agent/prompt.ts:99`                 | **P1** |
| S-04 | agent/rag 的 apiKey 未注册日志脱敏                        | 安全        | 中     | `src/components/welink/LlmSettingsCard.vue:72` | **P1** |
| S-05 | `http.rs` 错误串回传含密钥的完整 URL                      | 安全        | 中     | `src-tauri/src/http.rs:84`                     | **P1** |
| S-06 | 剪贴板读取无大小上限                                      | 安全/性能   | 中     | `src-tauri/src/shell.rs:112`                   | **P1** |
| S-07 | `shell_open` 本地文件侧不拒绝可执行扩展名                 | 安全        | 中     | `src-tauri/src/shell.rs:24`                    | **P1** |
| P-02 | `runtime.reload` 不重建 Agent 客户端，改配置不生效        | 性能/正确性 | 中高   | `src/orchestrator/runtime.ts:111`              | **P1** |
| S-08 | `sys_env_var` 无白名单，可读进程全部环境变量              | 安全        | 中     | `src-tauri/src/sysinfo.rs:164`                 | **P2** |
| S-09 | CSV 导出未防公式注入                                      | 安全        | 中     | `src/repositories/csv.ts:5`                    | **P2** |
| S-10 | CSP `connect-src` 允许任意 http/https                     | 安全/配置   | 中     | `src-tauri/tauri.conf.json:26`                 | **P2** |
| P-03 | `knowledge-harvester` 双定时链 + timerId 覆盖泄漏         | 性能        | 中     | `src/orchestrator/knowledge-harvester.ts:495`  | **P2** |
| P-04 | `poller.stop()` 后当前轮仍继续拉取剩余会话                | 性能        | 中     | `src/orchestrator/poller.ts:223`               | **P2** |
| P-05 | `jobIndex` 无界增长 + 每事件全量重建 Map                  | 性能        | 中     | `src/stores/welink/events.ts:82`               | **P2** |
| P-06 | 每条消息事件触发会话表全量拷贝 + 排序                     | 性能        | 中     | `src/stores/welink/events.ts:77`               | **P2** |
| P-07 | 多处串行 N+1 IPC（同步会话 / 启动恢复 / Gate 预热）       | 性能        | 中     | `src/stores/welink/view.ts:233`                | **P2** |
| P-08 | `hasOutgoingReceipt` 内容全文匹配，误判丢消息             | 正确性      | 中     | `src/infra/db/repos/welink.ts:766`             | **P2** |
| P-09 | 知识沉淀文件读放大（N+1 × 轮）                            | 性能        | 中     | `src/orchestrator/knowledge-harvester.ts:232`  | **P2** |
| S-11 | `db_migrate` 用 `execute_batch` 可多语句，绕过 SQL 黑名单 | 安全/架构   | 中     | `src-tauri/src/db.rs:427`                      | **P2** |
| S-12 | token 长度与 argv 暴露                                    | 安全        | 中     | `src/infra/codehub/exec.ts:37`                 | **P2** |
| P-10 | `table` store 全量 computed 每次行变更全表重算            | 性能        | 低     | `src/stores/table.ts:52`                       | **P3** |
| P-11 | `InboxTab` 时间线累积 limit 每次全量重拉                  | 性能        | 中     | `src/components/welink/InboxTab.vue:83`        | **P3** |
| S-13 | `.gitignore` 缺凭据/私钥规则                              | 安全/配置   | 中     | `.gitignore:35`                                | **P3** |
| 其他 | 见第四、五章（低危与理论隐患）                            | —           | 低     | —                                              | P3/P4  |

---

## 二、安全问题

### S-P1 · 保留期清理 100% 静默失效（已实测复现）

- **位置**：`src/infra/db/repos/welink.ts:861`（`purgeMessagesBefore`）、约束定义 `src/infra/db/migrations/welink.ts:56`、吞异常处 `src/orchestrator/retention.ts:118`
- **维度**：数据完整性 / 性能（无界增长）
- **严重程度**：**高**
- **验证**：已用 `node:sqlite` 复刻表结构与该DELETE 语句实测，结果为 `FOREIGN KEY constraint failed`，消息表**一行未删**。

**问题**：`purgeMessagesBefore` 执行

```sql
DELETE FROM welink_messages WHERE id IN (
  SELECT id FROM welink_messages WHERE sent_at < ?1 ORDER BY id LIMIT ?2)
```

而 `welink_reply_jobs.trigger_msg_pk` 声明为 `INTEGER NOT NULL REFERENCES welink_messages(id)`（`migrations/welink.ts:56`），**无 `ON DELETE` 子句**（默认 `NO ACTION`），同时 `src-tauri/src/db.rs:28` 显式 `PRAGMA foreign_keys = ON`。因此只要存在任意一条未被清理的 job 引用待删消息，整个 DELETE 即失败，一条都删不掉。

**连带效应**：`retention.ts:115-118` 用 `Promise.all` 并发跑消息与语料两条purge，`purgeMessagesBefore` 首个 `await` 即reject → 整轮 `doRun()` reject → 被 `retention.ts:153` 的 `.catch` 降级为一条 warn。**每日清理静默永久失败，`welink_messages` 无界增长**——这恰是 retention 模块存在的理由（`retention.ts:1-9`）。

**为什么单测没抓到**：`src/infra/db/repos/welink.spec.ts` 全部 mock bridge、只断言 SQL 文本，从未真正执行过 SQL。用例名与绿色结果会给人"已验证"的错觉。

**触发条件**：应用运行超过消息保留期（默认 180 天）且存在任一历史 job。100% 触发。

**建议修法**（推荐方案 1，不改表结构）：

```ts
async purgeMessagesBefore(cutoff: string, batch: number): Promise<number> {
  const result = await bridge.dbTransaction([
    { sql: `DELETE FROM welink_agent_logs WHERE job_pk IN (
             SELECT id FROM welink_reply_jobs WHERE trigger_msg_pk IN (
               SELECT id FROM welink_messages WHERE sent_at < ?1 ORDER BY id LIMIT ?2))`,
      params: [cutoff, batch] },
    { sql: `UPDATE welink_reply_jobs SET trigger_msg_pk = 0 WHERE trigger_msg_pk IN (
             SELECT id FROM welink_messages WHERE sent_at < ?1 ORDER BY id LIMIT ?2)`,
      params: [cutoff, batch] },
    { sql: `DELETE FROM welink_messages WHERE id IN (
             SELECT id FROM welink_messages WHERE sent_at < ?1 ORDER BY id LIMIT ?2)`,
      params: [cutoff, batch] },
  ])
  return result[2] ?? 0
}
```

> 备选：迁移加 `ON DELETE SET NULL` + 列改可空（需新版本迁移，且要先修历史悬挂引用）；或把`trigger_msg_pk` 改为存 `msg_uid` 彻底去掉跨表外键。

**配套动作（必做）**：补一条**真跑 SQLite** 的集成测试，覆盖 migration 全版本 + 各仓储方法。这类"单条 SQL 语法正确、组合起来违反约束"的缺陷，SQL 文本断言抓不到。

---

### S-01 · CLI 白名单只比主干名，`.bat/.cmd/.ps1` 全部放行

- **位置**：`src-tauri/src/cli.rs:81-85`（校验逻辑）、`src-tauri/src/cli.rs:150`（`Command::new`）
- **维度**：安全
- **严重程度**：**高**

**问题**：`assert_allowed` 只取 `Path::file_stem()` 与 `ALLOWED_STEMS` 比对，**完全不校验扩展名**。故`python.bat`、`python.cmd`、`python.ps1`、`..\\python` 均放行。批处理文件经 `CreateProcess` 会被 `cmd.exe` 解释执行 —— 白名单实际承诺变成了"能执行任意名为 `python.*` 的脚本"。

叠加问题：`cli.rs:36` 把 `python`/`python3`/`py` 放进了白名单，注释称用途仅为"只读 `--version` 探测"，但**Rust 侧对 args 毫无约束**，`cli_run(program="python", args=["-c", 任意代码])` 即为完整 RCE。

**已存在的防护（避免误报）**：args 以数组传给 `Command`、**不经 shell**，`%COMSPEC%%`、`&`、`|` 元字符注入这条路是堵死的。问题不在元字符，而在"什么文件被执行"这一层没有闸。

**触发条件**：攻击者能在 `cliPath` 指向目录或 PATH 早期目录写入 `python.bat`（内网环境常见：共享盘、下载目录）；或前端任一处把 program/args 交给用户输入。

**建议修法**：双白名单（主干名 + 扩展名），只允许 `.exe`/`.com`：

```rust
const ALLOWED_EXTS: &[&str] = &["exe", "com"];

let ext = Path::new(trimmed).extension()
    .map(|v| v.to_string_lossy().to_ascii_lowercase())
    .unwrap_or_default();
if !ALLOWED_EXTS.iter().any(|e| ext == *e) {
    return Err(format!("只允许 .exe/.com，收到扩展名：{ext}"));
}
```

同时建议从白名单**移除 `python`/`python3`/`py`**（`--version` 探测可用一次专用窄命令满足），或对 python 分支强制 args恰为 `["-V"]`/`["--version"]`。

---

### S-02 · 建群外呼完全绕过 safety-gate

- **位置**：`src/orchestrator/group.ts:52`、store 侧 `src/stores/group.ts:142`
- **维度**：安全
- **严重程度**：**高**

**已实测核查**（`grep -rn "\.send("`）：消息外发**唯一**调用点是 `src/orchestrator/pipeline.ts:496`，调用前必经 `gate.check()`（457行）+ `markStatus(pk,'sending','ready')` 乐观锁（490 行）；写 `status='sending'` 的点**仅** `pipeline.ts:490`。**消息方向「唯一外发出口」成立。**

但 `GroupPort.createGroup` 是**第二条真实外发路径**（拉真人进群），链路 `CreateTab.vue` → `stores/group.ts:142` → `orchestrator/group.ts:42` → `port.createGroup`，**完全不接触 safety-gate**：无急停、无总开关、无静默时段、无小时配额、无熔断、无频率限制。`panicStop()` 封不住它。

唯一防护是 `validateGroupDraft`（群名非空 + ≤64 字、成员非空）与 store 内 `creating` 布尔 —— 都是**输入合法性**校验，不是**外发策略**管控。

**触发条件**：助手处于"一键全停"或总开关关闭状态，用户仍可发起建群并成功外呼。

**建议修法**：给 gate 增加建群判定，或抽出共享的 `OutboundGate` 供两个方向复用：

```ts
const verdict = deps.gate.checkGroupAction({ kind: 'create_group' })
if (verdict.action !== 'send') throw new Error(verdict.detail)
```

并在 store `createGroup` 里先判 `runtime?.gate.snapshot().panic`。

> 另建议：无论最终是否纳入 gate，都应把 `safety-gate.ts:2-5` 的头部注释精确改写为"所有**消息**外发必经此处"，避免后来者误信当前覆盖面。

---

### S-03 · RAG / 知识库内容进提示词未消毒（多跳注入链）

- **位置**：`src/infra/agent/prompt.ts:99-101`（`knowledge`/`retrieved`/`docs` 不消毒）、`src/orchestrator/knowledge-harvester.ts:313`（auto 免审直写）、`src/orchestrator/pipeline.ts` 的 `formatRetrieved` / `formatBoundDocs`
- **维度**：安全（提示注入）
- **严重程度**：**中高**

**问题**：`sanitizeUntrusted` 只作用于 `context` 与 `question`（已确认 `prompt.ts:74,82`）；`{{retrieved}}`（RAG 片段）与 `{{docs}}`（本地文档）**明确不消毒**（`prompt.ts:97-98` 注释称可信）。但这两个来源并非纯可信——`retrieved` 索引的内容包含沉淀链自动写入的条目，而 `sediment.mode === 'auto'` 时（`knowledge-harvester.ts:313`，注释自标"K-E，显式风险"）**群消息 → LLM 提取 → 免审直写知识库**。

**完整注入链**：群内任意成员发一条含指令的消息 → auto 模式提取写入 `knowledge/*.md` → 该文档经 `{{docs}}`/`{{retrieved}}` 原样注入后续提示词 → 模型照做 → **回复以助手身份发进群**。该链上人工环节为零。

**建议修法**（可组合）：

1. 对 `formatRetrieved` / `formatBoundDocs` 的正文加**轻量结构消毒**（`sanitizeUntrusted(text, 2000)` 剥控制字符 + 拍平换行 + 标记 `【不可信内容】`），保留可读性同时阻断行结构伪造；
2. auto 模式写入的文档打 `untrusted` 标记，`formatBoundDocs` 对该来源强制消毒；
3. 提高 auto 门槛（如仅对 `sourceType === 'announcement'` 免审）。

> **正面记录**：`renderPrompt` 用**单遍 replace 而非链式 `replaceAll`**（`prompt.ts:103-106`），避免了"先替换进来的值被后续替换二次扫描"的占位符注入，且该用例由单测钉住。这是真实抓到的漏洞。

---

### S-04 · agent / rag 的 apiKey 未注册日志脱敏

- **位置**：`src/utils/logger.ts:26`（机制）、唯一注册点 `src/stores/codehub.ts:90`、缺失方 `src/components/welink/LlmSettingsCard.vue:72`、`src/components/welink/RagSettingsCard.vue:51`
- **维度**：安全（敏感信息）
- **严重程度**：**中**

**问题**：`registerSecret` 的等值替换兜底机制设计良好，但**只对 CodeHub token 生效**。`agent.apiKey`（`src/types/welink.ts:230`）与 `rag.apiKey`（`:280`）从未注册。而 `agent-http.ts:200-203` 会把`Agent 返回 HTTP ${status}：${text.slice(0,200)}` 拼进错误串 → 若网关在 4xx 响应体里回显请求信息，密钥将进入 `last_error`、`logger.error`、宿主日志文件与 **UI 运行日志面板**（用户可见），且不被遮蔽。

另一个隐患：两把 key 被拼进模块级缓存键字符串（`src/infra/agent/index.ts:42-50`），`cachedKey` 常驻内存。现在恰好没被打印（`:55-56` 只打 `model`），但**一条日志语句即可造成泄露**。

**触发条件**：网关回显请求头；或将来有人给缓存键数组加日志（很自然的排障动作）。

**建议修法**：在配置归一化出口统一注册，覆盖所有入口：

```ts
// types/welink.ts 的 normalizeAgentSettings / normalizeRagSettings 出口
registerSecret(normalized.apiKey)
```

> 注：apiKey 明文落`config.json` 是产品既定决策，本报告不视为缺陷，但建议评估 Windows DPAPI（见第七章）。

---

### S-05 · `http.rs` 错误串回传含密钥的完整 URL

- **位置**：`src-tauri/src/http.rs:84`、`http.rs:86`、`http.rs:88`
- **维度**：安全（敏感信息）
- **严重程度**：**中**

**问题**：reqwest的 `Error: Display` 实现必然包含完整 URL（含 query 与 userinfo）。`http.rs:82-89` 三个分支都用 `{error}` 原样拼接回传前端。OpenAI 兼容端点常见 `?api-key=xxx` 形态鉴权，连接失败时密钥会经`Err` 字符串进入前端，可能被 `append_log` 写进日志文件。

**正面记录**：Rust 侧**不打印**该错误串，泄漏需前端恰好记日志，影响被压低。

**建议修法**：

```rust
fn describe_transport_error(error: &reqwest::Error, timeout: Duration) -> String {
    let stripped = error.without_url(); // Display 内含完整 URL，URL 里可能带 key
    if error.is_timeout() { format!("Agent 请求超时（{}ms）：{stripped}", timeout.as_millis()) }
    else if error.is_connect() { format!("Agent 连接失败：{stripped}") }
    else { format!("Agent 请求失败：{stripped}") }
}
```

---

### S-06 · 剪贴板读取无大小上限

- **位置**：`src-tauri/src/shell.rs:112-121`
- **维度**：安全 / 性能
- **严重程度**：**中**

**问题**：`GlobalSize(hmem)` 返回的字节数直接用于构造 Rust 切片并全量 UTF-16 → UTF-8 转换。剪贴板内容**完全由外部进程控制**，用户从浏览器复制一个 200MB 的 base64 图片即可让本命令分配同等内存。

**对比**：`cli.rs:25` 的 `MAX_OUTPUT = 2MB`、`http.rs:19` 的 `MAX_BODY = 2MB` 都有限制，唯独剪贴板这条外部数据入口漏了 —— 属一致性缺口。

**建议修法**：加同源上限，且应在 `GlobalLock` **之前**判断（避免内存已锁住才发现超限）：

```rust
const MAX_CLIPBOARD: usize = 8 * 1024 * 1024;
if size as usize > MAX_CLIPBOARD {
    return Err("剪贴板内容过大，已拒绝读取".into());
}
```

---

### S-07 · `shell_open` 本地文件侧不拒绝可执行扩展名

- **位置**：`src-tauri/src/shell.rs:24-27`
- **维度**：安全
- **严重程度**：**中**

**问题**：

```rust
let is_url = target.starts_with("http://") || target.starts_with("https://");
if !is_url && !std::path::Path::new(&target).exists() {
    return Err(format!("打开目标不存在：{target}"));
}
```

两个问题：①协议判断**大小写敏感**，`HTTP://` 过不了前缀匹配；②**本地文件侧只要 `exists()` 为真即放行，不校验扩展名** —— 可打开存储根下任意已存在的 `.exe`/`.bat`/`.ps1`/`.lnk`（`ShellExecuteW` 的 `open` 动词对可执行文件即等于运行）。配合 `fs_write`（可写根下任意相对路径）构成"写入 → 执行"链。

**建议修法**：

```rust
const DANGEROUS_EXTS: &[&str] = &["exe","com","bat","cmd","ps1","vbs","js","msi","lnk","jar"];
let ext = Path::new(&target).extension()
    .map(|v| v.to_string_lossy().to_ascii_lowercase()).unwrap_or_default();
if DANGEROUS_EXTS.contains(&ext.as_str()) {
    return Err(format!("拒绝打开可执行/脚本文件：{ext}"));
}
```

协议判断改为大小写不敏感，或用 URL 解析器判定 scheme 而非前缀匹配。

---

### S-08 · `sys_env_var` 无白名单

- **位置**：`src-tauri/src/sysinfo.rs:163-166`
- **维度**：安全
- **严重程度**：**中**

**问题**：任意变量名，无枚举、无白名单、无长度限制。这与该文件自身声明的边界矛盾（`sysinfo.rs:3` 写"只读、无业务规则"，但其余部分都是从固定常量取特定系统信息，唯独这里开了"读任意 key"的通用口子）。

**触发条件**：前端传`name = "AWS_SECRET_ACCESS_KEY"` / `"DATABASE_URL"` 等任何继承到 GUI 进程的环境变量。企业环境中通过组策略下发的变量（`HTTP_PROXY` 含凭据等）均可能被读到。

**建议修法**：改为显式白名单（与 `sys_overview` 已用到的三个常量一致即可），或直接删除此命令 —— `sys_overview`（`sysinfo.rs:147-148`）已覆盖 `COMPUTERNAME`/`USERNAME`。

---

### S-09 · CSV 导出未防公式注入

- **位置**：`src/repositories/csv.ts:5-8`（`cell()`）
- **维度**：安全
- **严重程度**：**中**

**问题**：`cell()` 只做了 RFC 4180 的逗号/引号/换行转义，**完全没防公式注入**。`TableCrudView.vue` 的名称/分类/负责人/创建日期均为自由文本输入（仅 `maxlength`，无字符集白名单），用户填入 `=1+1`、`@SUM(A1)`、`+cmd|' /C calc'!A0` 后导出，用 Excel 打开会被当公式求值。

**触发条件**：填入恶意公式 → 导出 CSV → 用 Excel 双击打开。

**建议修法**（OWASP 口径）：

```ts
function cell(value: string | number): string {
  let text = String(value)
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}` // 前置单引号阻断公式求值
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}
```

> 取舍说明：加单引号后单元格显示会带前导 `'`。若不接受，改为导出时对危险前缀单元格用 `="` 包裹并提示用户。

---

### S-10 · CSP `connect-src` 允许任意 http/https

- **位置**：`src-tauri/tauri.conf.json:26`
- **维度**：安全 / 不安全配置
- **严重程度**：**中**

CSP 原文：

```
default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:;
font-src 'self'; connect-src 'self' http: https:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'
```

逐项评估：`script-src 'self'` **无 `unsafe-inline`/`unsafe-eval`（配置正确，关键项）**；`object-src 'none'`、`frame-ancestors 'none'`、`base-uri 'self'` 均正确；`style-src 'unsafe-inline'` 必要且可接受（Element Plus 依赖运行时注入样式）。

**唯一实质风险点是 `connect-src 'self' http: https:`** —— 字面含义是 WebView 内 `fetch` 可向**任意域**发请求。

**结合代码判断**：应用层已有 SSRF 闸门（`agent-http.ts:95-104`、`rag-http.ts:60-70` 对 IP 字面量做私网/回环白名单），**但域名形式的 `baseUrl` 一律放行**（注释明说"域名（公网/内网均可）"，因为 DNS 解析结果不在 TS 侧）。这意味着一个被篡改的 `config.json` 或被诱导填入的 baseUrl，可让完整聊天原文 POST 到任意外部服务器。UI 侧只有橙色告警，**不阻断**。

另注：Agent/RAG 请求在 Tauri 生产路径下走宿主 `reqwest`（因大模型服务不回 CORS 头），故 `connect-src` 的实际暴露面主要是浏览器降级路径。

**建议修法**：

1. **收紧 CSP 为显式白名单**：`connect-src 'self' https://llm-gateway.example.com https://rag.intranet.example.com`（按实际部署填写），作为纵深防御；
2. 把UI 侧告警**升级为保存时阻断**（与 CodeHub `cliPathMissing` 拦保存同款处理）；
3. 宿主 `reqwest` 侧再加一层出站域白名单。

---

### S-11 · `db_migrate` 可多语句执行，绕过 SQL 黑名单

- **位置**：`src-tauri/src/db.rs:427`（`execute_batch`）、黑名单定义 `src-tauri/src/db.rs:202-207`
- **维度**：安全 / 架构
- **严重程度**：**中**

**两个问题**：

1. **架构违规**：项目自称"Rust 只做薄桥接、无业务规则"，但 `FORBIDDEN_SQL` 是明确的**策略代码**，且 `db.rs:188-201` 用 13 行注释阐述威胁模型。代码自己也承认（`:201`）真正防线是"SQL 全在 TS、参数一律 `?` 绑定"。
2. **防线不一致（真实缺陷）**：`guard_statement` 只挡 4 个关键字，而 `db_migrate` 用的是 `execute_batch` —— 已核对 rusqlite 0.37 源码，`execute_batch` 会循环 prepare 全部语句，**天然支持多语句**；而 `db_execute`/`db_select`/`db_transaction` 用的 `execute`/`prepare` 在检测到 tail 非空时返回 `Error::MultipleStatement`，**单语句是被强制的**。结论：`ATTACH DATABASE 'D:\x.db'` 无法通过 `db_execute`，但能通过 `db_migrate`。

**真实风险等级为中而非高**：迁移 SQL 由仓库内 TS 定义（可信），需前端被攻陷才触发；按 `db.rs:190-192` 自陈的威胁模型（能改前端就能重新打包），这不构成有效防线。

**建议修法**：把 `guard_statement` 升格为逐条 prepare 的 `guard_statements`，遇多语句直接拒绝（对齐 `db_execute`）；同时把 `FORBIDDEN_SQL` 下沉到 TS侧，Rust 只保留"单语句"硬约束 —— 既消除不一致，也让宿主回归薄桥接。

---

### S-12 · token 长度侧信道与 argv 暴露

- **位置**：`src/infra/codehub/exec.ts:37-40`（长度泄露）、传参 `src/infra/codehub/codehub-cli.ts:50`
- **维度**：安全（敏感信息）
- **严重程度**：**中**

**两个问题**：

1. **长度侧信道**：脱敏产出 `[token 已省略 ${arg.length} 字]`，把密钥精确长度写进错误串 → 落`last_error` 与日志文件。
2. **argv 暴露**：token 以 `--token <值>` 出现在子进程命令行（`codehub-cli.ts:50`），Windows 上同机其他进程可用 `Get-CimInstance Win32_Process` 读到完整命令行。项目是内网单机桌面应用，同机存在其他进程是常态。

**正面记录**：TS 侧 `registerSecret` 已做等值遮蔽兜底，且 `stores/codehub.ts:90,219` 确实注册了 token；Rust 侧也未把 argv 写入日志。

**建议修法**：

- 立即可做：`out.push('[token 已省略]')`，去掉长度输出；
- 通道级：改用环境变量或 stdin 传 token（`codehub-cli.ts` 文件头的 `[CLI-ASSUME] 2` 本就标注"参数名与位置待核实"，正是改动窗口）；
- 对接真实 CLI 时把该项列入显式安全评审。

---

### S-13 · `.gitignore` 缺凭据 / 私钥规则

- **位置**：`.gitignore:35-40`（当前仅覆盖 `*.log`）
- **维度**：安全 / 配置
- **严重程度**：**中**

**问题**：`.gitignore` 的逻辑组织很好，且用注释解释了"三个 unplugin 生成文件必须提交"的理由，但**没有任何一条针对密钥/凭据的规则**。缺失项：`*.pem`/`*.key`/`*.pfx`/`*.p12`、`*.crt`、`.env`/`.env.*`、`*.token`、`*credentials*`、`*secret*`，以及**本项目专有的 `config.json`** —— `src/stores/app.ts:60` 把含 token/apiKey 的完整 `AppSettings` 明文写入它。

**触发条件**：开发者把真实 `config.json` 拷到仓库根调试；或将来改成"配置放仓库内"。

**建议修法**（只增不删）：

```gitignore
# 凭据与私钥（config.json 里的 token/apiKey 是明文，见 stores/app.ts 的 saveConfig）
.env
.env.*
!.env.example
*.pem
*.key
*.pfx
*.p12
config.json
!src-tauri/tauri.conf.json
*.token
```

配套建议加 `gitleaks` / `git-secrets` pre-commit 钩子（当前 `.git/hooks/` 下只有两个空钩子，无 `pre-commit`）。

---

### 其他安全问题（低危 / 理论隐患）

| ID   | 问题                                                                                        | 位置                                             | 严重度     | 建议                                        |
| ---- | ------------------------------------------------------------------------------------------- | ------------------------------------------------ | ---------- | ------------------------------------------- |
| S-14 | `token` 脱敏漏掉 `--name`/`--members`（群名与成员工号进错误串）；建议改为按参数名的映射表   | `src/infra/welink/exec.ts:42`                    | 低         | 扩`REDACT_FLAGS` 集合                       |
| S-15 | `parseJson` 把前 160 字符原文拼进错误串                                                     | `src/infra/welink/adapter.ts:48`                 | 低         | 改为长度 + 首行特征                         |
| S-16 | `logger.info` 打印 `baseUrl`，若用户把凭据写进 URL 会泄露                                   | `src/infra/agent/index.ts:56`                    | 低         | 打印前剥离 userinfo                         |
| S-17 | 会话 ID / 仓库标识输入无长度与字符集校验                                                    | `ConfigTab.vue:160`、`CodehubReviewView.vue:242` | 低         | 加 `maxlength` + 正则白名单                 |
| S-18 | `editAndSend` 无状态守卫，可覆写 `discussing` 中的草稿（用户输入被 `commitDraft` 静默覆盖） | `src/stores/welink/data.ts:85`                   | 中         | `updateDraft` 加 `AND status IN (...)` 守卫 |
| S-19 | `fs.rs` 复核→写入间存在 TOCTOU（junction 替换窗口）                                         | `src-tauri/src/fs.rs:92-96`                      | 低（理论） | 存储根不接受重解析点                        |
| S-20 | `notify_send` 每次新建 HWND、`uID` 固定为 1，通知重叠时互相删除                             | `src-tauri/src/shell.rs:249`                     | 低         | 改进程内单例 + 单调 `uID`                   |
| S-21 | 建群成员数无上限，1 万人会产生数 MB 的单个 argv                                             | `src/orchestrator/group.ts:20`                   | 低         | 加成员数上限 + 去重                         |
| S-22 | S7 黑名单正则用户可配且每次 check 重新编译，ReDoS 可卡死主线程                              | `src/orchestrator/safety-gate.ts:207`            | 中         | 缓存编译结果 + 限制模式长度                 |
| S-23 | 复制到剪贴板含完整对话原文，无二次确认                                                      | `TraceTab.vue:175`、`HistoryTab.vue:244`         | 低         | 文案明示"含原文"                            |

> S-22 说明：`safety-gate.ts:203-213` 的语法错误已被 `try/catch` 妥善处理，缺的是**执行时间上界**。外发段严格串行，一次回溯卡死即整个助手停摆。

---

## 三、性能问题

### P-01 · `retention.stop()` 后清理器永久失效（已实测确认行号）

- **位置**：`src/orchestrator/retention.ts:170`（`disposed = true`）、`:164`（`start()` 首行 `if (disposed) return`）、`:148`（`schedule()` 内 `if (disposed) return`）；调用链 `src/orchestrator/runtime.ts:230`（`stop()` 调 `retention.stop()`）、`runtime.ts:219`（`start()` 调 `retention.start()`）
- **维度**：内存占用 / 缓存策略
- **严重程度**：**高**

**问题**：`stop()` 置 `disposed = true` 且**无任何复位入口**。`runtime.stop()`（用户关总开关）会调用它，此后 `runtime.start()` 里的 `retention.start()` 永久 no-op。

**已复核确认**：`runtime.ts` 中 `retention` 仅出现在 `169`（创建）、`203`（导出）、`219`（start）、`230`（stop）、`240`（purgeNow）—— **确实没有 `reopen`/`reset` 之类的复位调用**。

**触发条件**：用户关一次总开关再打开 —— 此进程内消息表/语料表**永不清理**，且无任何用户可见信号。

**建议修法**：区分"暂停"与"永久销毁"：

```ts
stop() { disposed = true; this.clearTimer(); }
reopen() { disposed = false; }        // 新增
start() { if (timer !== null || inFlight) return; schedule(firstDelayMs); }  // 去掉 disposed 判断
```

`runtime.start()` 改为 `retention.reopen(); retention.start()`。或令 `runtime.stop()` 只调 `retention.pause()`（清 timer 不置 disposed），把 `disposed` 留给真正的 `dispose()`。

> **注意**：本条与 S-P1 叠加 —— 即使修好 P-01，若不修 S-P1，清理器启动后每轮仍会失败。**两条必须一起修**。

---

### P-02 · `runtime.reload` 不重建 Agent 客户端，改配置不生效

- **位置**：`src/orchestrator/runtime.ts:111`（`agentInstance` 固定构造）、`:114`（`ragInstance` 用getter）、`reload()` 在 `:247`
- **维度**：缓存策略 / 正确性
- **严重程度**：**中高**

**问题**（已复核原文）：

```ts
const agentInstance = resolveAgent ?? agentClient({ settings: currentSettings.agent })
// rag 实例经工厂 getter 注入：reload 换配置后下一次检索自动取到新实例（热更新）
const ragInstance = () => ragClient({ settings: currentSettings.rag })
```

`agentInstance` 在 `createWelinkRuntime` 时以**配置快照构造一次**；`reload(next)` 只更新 `currentSettings` 与 gate，从不重建 agent。`agentClient()` 本身有完整的配置键缓存（`src/infra/agent/index.ts:42-51`），但因只被调用一次，**缓存永远命中旧实例**。

**注释只解释了 rag 用 getter 的理由，agent 没有** —— 这是明确的疏漏而非有意设计。

**触发条件**：用户在设置页改 `baseUrl`/`endpoint`/`model`/`apiKey` → UI 提示"改完即生效"，实际管线仍用旧端点，表现为"配置改了但回复还是旧模型"。

**建议修法**：与 rag 对称改成 getter：

```ts
const agentInstance = () => resolveAgent ?? agentClient({ settings: currentSettings.agent })
// pipeline.ts:60 的 agent: AgentClient 类型需放宽为 AgentClient | (() => AgentClient)
```

---

### P-03 · `knowledge-harvester` 双定时链 + timerId 覆盖泄漏

- **位置**：`src/orchestrator/knowledge-harvester.ts:495`（`schedule()`）、`:503`（链尾再排）、`:514`（stop）
- **维度**：定时器生命周期
- **严重程度**：**中**

**问题**：`schedule()` 直接 `timerId = timers.set(...)`，**不先 clear**。对比 `poller.ts:124`、`codehub-sync.ts:88`、`pipeline.ts:640` 三处都先清 —— 这里是唯一的例外。若 `runRound()` 在飞时发生 stop→start，链尾 `schedule()` 与新 `start()` 的 `schedule()` 各排一根，`timerId` 只保留后者，前者**永久失去句柄、永不清理**，此后每轮间隔再泄漏一根。

**触发条件**：LLM 提取慢（`timeoutMs` 上限 300s）时关/开助手，或点"立即提取"同时开关总开关。

**建议修法**：

```ts
const schedule = () => {
  if (!running) return
  if (timerId !== null) timers.clear(timerId)   // 补这一行
  timerId = timers.set(async () => { ... }, ...)
}
```

---

### P-04 · `poller.stop()` 后当前轮仍继续拉取剩余会话

- **位置**：`src/orchestrator/poller.ts:223-253`（for 循环）、`:410-413`（`delay()` 错峰定时器）、`:336`（stop）
- **维度**：定时器生命周期
- **严重程度**：**中**

**问题**：`stop()` 只清链式 `timer`，**不清 `delay()` 创建的错峰定时器**；`for (const conv of due)` 循环体内**无 `running` 检查**。误点"立即拉取"后再关助手，剩余 N-1 个会话照常起 CLI 子进程。

**触发条件**：监控 20+ 会话、错峰 300ms 时，用户在轮询中途点"暂停"。

**建议修法**：循环内补守卫（`if (!running) break`，错峰 `await` 前后各一次）。

---

### P-05 · `jobIndex` 无界增长 + 每事件全量重建 Map

- **位置**：`src/stores/welink/events.ts:82-83`、`:114`；`src/stores/welink/view.ts:135`
- **维度**：算法复杂度 / 内存泄漏
- **严重程度**：**中**

**问题**：`jobIndex`（`shallowRef<Map>`）只增不减 —— `listJobs`、`listJobsByStatus`、`patchJob`、`refreshReviewCount` 全往里塞，**没有任何淘汰**。每次写入后 `new Map(jobIndex.value)` 是 O(n) 全量拷贝，且 `shallowRef` 的浅比较依赖新引用，**强制触发下游 computed 重算**。

**触发条件**：长跑（数天不重启）+ 大量 `jobStatusChanged` 事件 → 单事件 O(n)，总O(n·events)。

**建议修法**：改用 `reactive(new Map())` 免全量拷贝；并设淘汰规则（仅保留待审 + 未终态 + 当前会话），终态且无 hold 的条目 `delete`。

---

### P-06 · 每条消息事件触发会话表全量拷贝 + 排序

- **位置**：`src/stores/welink/events.ts:77`、`src/stores/welink/index.ts:252`、`src/stores/welink/aggregate.ts:37-39`
- **维度**：循环中重复计算
- **严重程度**：**中**

**问题**：每次 `messagesAppended` 都 `conversations.value = [...conversations.value]`（500 元素数组拷贝），使 `watchingConversations`（filter + sort）与 `unreadTotal`（reduce）缓存失效。同一函数内还连做两次 `rows.filter`（`:71`、`:73`）。`mergeTimelinePage` 每次追加都对整个时间线 `[...existing, ...additions].sort(...)`。

**触发条件**：20 个监控会话 → 单轮 20 次 500 元素拷贝 + 20 次排序；用户上翻到数千条后每条新消息都整表重排。

**建议修法**：`conversations` 改 `shallowRef` + 按 convId 建 `Map` 索引做定点更新；`mergeTimelinePage` 因追加消息 `sentAt` 单调递增，可只做末尾插入判断而非全量 sort。

---

### P-07 · 多处串行 N+1 IPC

- **位置**：`src/stores/welink/view.ts:233-243`（同步会话）、`src/orchestrator/bootstrap.ts:114`（启动恢复逐个查回执）、`bootstrap.ts:177-183`（Gate 预热）
- **维度**：I/O 阻塞 / 数据库查询效率
- **严重程度**：**中**

**问题**：

1. `syncConversations`：`for` 循环内串行 `await upsertConversation`，每次 upsert 内部是 SELECT→UPSERT→**回读**三次 IPC。500 个候选 = **1500 次串行往返**。
2. `bootstrap` 恢复：遍历 `unfinished`（上限 2000）逐个 `await hasOutgoingReceipt(pk)`，而该查询是**相关子查询 + `content` 无索引**，每个会话内扫描一遍消息表。
3. Gate 预热：`for (const conv of watching)` 内 `await Promise.all([...])` —— `Promise.all` 只在**轮内**并行，轮与轮之间完全串行。1000 个会话 = 2000 次串行往返。注释说"避免 N 次查询"，实际只是把 2N 降成 2N（顺序不同）。

**建议修法**：仓储层加批量方法（`upsertConversations(drafts[])`、`resolveSendingJobs(pks[])` 用 `IN` 一次取回、`countSentSinceBatch(convIds[], since)` 用 `GROUP BY`）；或分片并发（每片 ≤20）。

---

### P-08 · `hasOutgoingReceipt` 内容全文匹配，误判丢消息

- **位置**：`src/infra/db/repos/welink.ts:766-775`
- **维度**：正确性（防双发）/ 性能
- **严重程度**：**中**

**问题**（已复核原文）：

```sql
SELECT COUNT(*) AS count FROM welink_messages m
 WHERE m.direction = 'out' AND m.conv_pk IN (...)
   AND m.content = (SELECT draft FROM welink_reply_jobs WHERE id = ?1)
```

两个问题：① `m.content` 无索引且子查询无法走索引 → **每次防双发核对都付全量扫描代价**；② **按内容全文匹配，误判率极高** —— 模型生成的草稿高度模板化，若历史上发过内容完全相同的 out 消息，会被误判为"已发出"→ 触发 `pipeline.ts:425` 的 `recoverAsSent`，把一个**从未发送**的 job 标记成 `sent` 并计入配额，**该条回复被静默丢弃**。

**建议修法**：改用 msg_uid 关联而非内容比对。`markSent`（`welink.ts:753`）已用 `INSERT OR IGNORE ... msg_uid` 做了幂等，说明 msgUid 是可靠关联键 —— 给 `welink_reply_jobs` 加一列记录本次外发尝试的 msg_uid，回查按它走。

---

### P-09 · 知识沉淀文件读放大（N+1 × 轮）

- **位置**：`src/orchestrator/knowledge-harvester.ts:232-234`（`knownDocHashes` 每轮读完全部文档）、`:399`（`approve` 每次列目录+读全文）、`:314-321`（auto 模式对每 draft 调 approve）、`:344-355`（`archiveQaRound` 逐条读改写）
- **维度**：I/O 阻塞
- **严重程度**：**中**

**问题**：四处叠加放大。`appendDoc` 是"读整文件 → 拼接 → 整体覆写"，单轮 60 条 × 64KB 全量重写。

**建议修法**：`listDocs()` 结果在本轮内缓存复用；`approve` 传入已算好的判定结果；`archiveQaRound` 按 file 分组后一次性 append 拼接。

---

### P-10 · `InboxTab` 时间线累积 limit 每次全量重拉

- **位置**：`src/components/welink/InboxTab.vue:83-87`（`loadEarlier`）
- **维度**：性能
- **严重程度**：**中**

**问题**：`loadEarlier()` 每次 `detailLimit += 100` 后用**累积 limit 重新全量拉取**，而非增量 prepend。点 N 次后每次都从 DB 拉 N×100 条，并整体替换数组触发全量 diff 渲染。

**对比**：`src/components/welink/messages/TimelinePanel.vue:49` 走的是 store 的 `loadEarlierMessages()` **增量前插 + in-flight 锁** —— `InboxTab` 是同一份数据的第二套实现，语义与性能都更差。

**建议修法**：统一到 store 的增量路径，并给 `detailLimit` 补硬顶（如 500）作为兜底。

---

### 其他性能问题（低危）

| ID   | 问题                                                                                          | 位置                               | 严重度 | 建议                                  |
| ---- | --------------------------------------------------------------------------------------------- | ---------------------------------- | ------ | ------------------------------------- |
| P-11 | `countJobs` 携带两个不参与过滤的 LEFT JOIN（`countJobsWithLogs` 写法是对的，两者不一致）      | `src/infra/db/repos/welink.ts:595` | 低     | 去掉多余 JOIN                         |
| P-12 | `jobStats` 全表扫描 + 计算了没人用的 `attempted_hour`                                         | `welink.ts:607`                    | 低     | 加时间窗、删无用聚合                  |
| P-13 | `applyPollResult` 用秒级 `created_at` 回捞 job，同秒碰撞会串号                                | `welink.ts:449`                    | 中     | 加 `apply_batch_id`                   |
| P-14 | `insertAgentLog` 的 seq 是 check-then-act 竞态                                                | `welink.ts:816`                    | 低     | 事务化 + 唯一索引                     |
| P-15 | `applyAnnouncements` 是 N+1 且逐条 await（同文件其他批量写入已正确用事务）                    | `sediment.ts:129`                  | 中     | 批量化 + 会话行去重缓存               |
| P-16 | `pipeline enqueue` 用 `includes()` 去重，O(n²)；启动恢复 2000 个约 1200 万次比较              | `pipeline.ts:708`                  | 低     | 配Set 影子索引                        |
| P-17 | `manualOverride` / `generateRetries` 只增不减（提前 return 时残留，还可能错误绕过 hold）      | `pipeline.ts:133`、`:765`          | 低     | 所有 return 前统一清理                |
| P-18 | `selectConversation` 取全局最旧 200 条再按会话过滤，应下推 `targetId`                         | `src/stores/welink/view.ts:162`    | 中     | 用`listJobs({targetId})`              |
| P-19 | `appStore`深监听 → 每次按键全量 `JSON.stringify` 配置并落盘                                   | `src/stores/app.ts:74`             | 低     | in-flight 去重 + trailing debounce    |
| P-20 | `table` store 五个 computed 全依赖 `rows`，任一行变更全表重算                                 | `src/stores/table.ts:52`           | 低     | 已知取舍（千级够用）                  |
| P-21 | `resolve_storage` 每次调用都做 `probe_writable`（建目录+写探针+删文件），被 12 个命令反复触发 | `src-tauri/src/storage.rs:187`     | 中     | 探测结果缓存，迁移后失效              |
| P-22 | `http_post_json` 每次新建 `reqwest::Client`，无连接池复用                                     | `src-tauri/src/http.rs:45`         | 低     | `OnceLock` 缓存默认 timeout 的 Client |
| P-23 | `fs_read` / `read_file` 无大小上限，全量读入并经 IPC 序列化                                   | `src-tauri/src/fs.rs:80`           | 中     | 加同源上限（8MB）                     |
| P-24 | `TimelinePanel` 每条消息重复 7 次 `jobOfMessage()` 线性查找                                   | `TimelinePanel.vue:22`             | 低     | 改 Map 索引                           |
| P-25 | `TraceTab` 模板内对 prompt 做两次全量字符串切分，未 memo                                      | `TraceTab.vue:305-310`             | 低     | 提到 computed 里缓存                  |
| P-26 | `skill-router` 每次路由重编译全部关键词正则（双重循环内）                                     | `skill-router.ts:48`               | 低     | 按 keyword 缓存                       |

---

## 四、明确「未发现问题」的项（否定结论，避免重复排查）

这几项是常见的高风险面，逐项核查后确认当前安全，记录在此以免后续重复排查：

| 检查项               | 结论           | 依据                                                                                                                                                                                                                                                                                                                                                  |
| -------------------- | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **XSS**              | **零风险**     | 全量 grep `v-html`/`innerHTML`/`eval`/`new Function`/`document.write` 在 `src/` 下**零命中**。所有外部数据（群消息、MR 标题描述、检视意见、运行日志、prompt/response）一律走 `{{ }}` 文本插值，Vue 不做HTML 解析。动态 `href` / `target="_blank"` 业务代码零命中（仅 `api/web.ts:169` 浏览器降级分支有 `window.open(..., 'noopener')`，非生产路径）。 |
| **SQL 注入**         | **零注入点**   | `src/infra/db/repos/*` 全部用户可控值走 `?N` 绑定；`${}` 插值只出现在**代码内常量**与**枚举白名单**上。`placeholders(count)` 由数量生成序号，天然免疫。                                                                                                                                                                                               |
| **LIKE 通配符注入**  | **已正确防护** | `src/infra/db/like.ts:8-10` 转义 `\ % _`，四处使用**全部配套 `SQL ESCAPE '\'`**。搜「50%」是字面匹配而非全表通配，且有单测钉住。                                                                                                                                                                                                                      |
| **消息外发唯一性**   | **成立**       | `port.send()` 生产代码**仅** `pipeline.ts:496` 一处，前置 gate +乐观锁。                                                                                                                                                                                                                                                                              |
| **分页强制**         | **彻底**       | 所有列表 SQL 带 `LIMIT`；两处受控例外（`WATCHING_HARD_LIMIT=1000`、`UNFINISHED_HARD_LIMIT=2000`）都有注释说明理由，且 SQL 层仍带硬上限。不存在无 LIMIT 全表 SELECT（`listSyncStates` 表结构决定最多等于仓库数，可接受）。                                                                                                                             |
| **sourcemap泄露**    | **无**         | `vite.config.ts` 未设 `build.sourcemap`（默认 false），实测 `dist/` 下零个 `.map`、全量 grep `sourceMappingURL` 零命中。                                                                                                                                                                                                                              |
| **TS 严格性**        | **优秀**       | `strict`/`noUnusedLocals`/`noUnusedParameters`/`noImplicitOverride`/`verbatimModuleSyntax`/`isolatedModules` 全开。业务代码 `: any`/`as any` **0 处**、`@ts-ignore` **0 处**、`@ts-expect-error` **0 处**、`: Record<string, any>` **0 处**。                                                                                                         |
| **TLS 校验**         | **完整**       | reqwest 走 `native-tls`/系统 schannel，**无** `danger_accept_invalid_certs` / `disable_certificate_validation`。                                                                                                                                                                                                                                      |
| **组件层定时器泄漏** | **无**         | 组件内无 `setInterval`；5 个配置卡的防抖 `setTimeout` 全部配对 `clearTimeout` + `onBeforeUnmount`。                                                                                                                                                                                                                                                   |
| **前端校验绕过**     | **不适用**     | 本地应用无登录模型，不存在绕过前端校验即可提权的路径。且宿主有独立把关：`fs.rs:46-68` 符号链接防护（且明确在 `create_dir_all` **之前**校验）、`agent-http.ts:95-104` / `rag-http.ts:60-70` IP 白名单。                                                                                                                                                |

---

## 五、依赖与构建配置

### 依赖漏洞（`npm audit` 实测）

> **说明**：默认镜像源不支持 audit API（`404 NOT_IMPLEMENTED`），已改用官方 registry 完成审计。以下条目**全部来自实测输出，无编造 CVE**。

**生产依赖（`--omit=dev`）：1 个 high**

| 包              | 严重度 | 通告                                                       | 实际可达性                                                                                                                                     |
| --------------- | ------ | ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `source-map-js` | high   | GHSA-68fv-2mgg-jv7q（索引 sourcemap 偏移导致事件循环 DoS） | 仅参与**构建期** sourcemap 生成，**运行时不加载**；且本项目不生成也不分发 sourcemap（见上表）。**实际不可达。** `npm audit fix` 可无破坏修复。 |

**开发依赖：3 critical + 1 high + 2 moderate**，集中在 vitest 链（`vitest`/`tinypool`/`happy-dom`/`glob`/`@vitest/mocker`/`@vitest/coverage-v8`）。

**风险面判断（重要）**：这是**内网离线单机桌面应用**，不存在公网 Web 那种"用户输入直连渲染"的暴露面。3 个 critical 的 RCE 只在测试进程内可触发，攻击前提是测试环境执行了不可信输入，而 `vitest.config.ts:27` 的 `include` 仅跑自有单测。**因此不建议为这 7 条警报做紧急升级。**

若要处理，优先级：

1. `happy-dom` 升到 `>=20.14.5`（patch 内可解，修3 条 critical，收益/风险比最高）；
2. `vitest` 升到 `>=4.1.11`（需复核 `vitest.config.ts:14` 的 `@ts-expect-error` 与 coverage阈值配置格式）；
3. `npm audit fix` 修 `glob` 与 `source-map-js`（无破坏）。

建议在 CI（`.github/workflows/verify.yml`）加一步 audit 门（该workflow 已在 `windows-latest` 联网，`npm ci` 本身就联网，与"内网离线是**运行时**约束"的区分不冲突）。

### 打包链安全性：**无问题**

- `scripts/build.mjs:132` 显式传 `--offline`，`:99` 注释标注为"内网离线打包的关键不变量，**勿删**"，`:110-112` 解释了实质意义（让"缓存缺失"变成**构建期硬失败**而非悄悄联网）。**这是把业务约束写进代码而非靠约定，值得肯定。**
- PE 导入表硬校验（`build.mjs:153-216`）手工解析 header / section / import directory，命中 `FORBIDDEN` 特征集即 `process.exit(1)`。
- **客观陈述的三点加强空间**：① 只覆盖**导入表**，延迟加载目录与运行时 `LoadLibrary` 不在检查范围；② `FORBIDDEN` 是**黑名单**，新增未列入模式的可分发 DLL 不会被拦；③ 终止条件遇畸形表结构可能提前结束扫描。
- 建议：(a) 同时解析延迟导入表；(b) 改为**白名单**（只放行 `kernel32`/`user32`/`advapi32` 等已知系统 DLL）；(c) 补"产物目录下不得存在额外 `.dll`"断言。

### CI：双门设计合理

`verify.yml`（快速门：lint + prettier + typecheck + test:coverage + build:web）与 `full-verify.yml`（完整链）分离的理由在 `verify.yml:1-13` 有完整说明（"必须是 windows，因为产物目标是 Windows 单文件 exe，Linux runner 上验证等于白跑"）—— 判断正确。`concurrency` 取消同分支旧运行（`:25-27`）实践得当。**唯一缺口是依赖漏洞门。**

---

## 六、修复路线建议

### 第一批（P0，建议立即处理）

| 项                          | 理由                                                                                                                  |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| **S-P1** 保留期清理外键失败 | 唯一"100% 触发且静默失效"的缺陷，直接导致数据无界增长；现有单测因全 mock 无法发现。**必须同时补真 SQLite 集成测试。** |
| **S-01** CLI 白名单扩展名   | 唯一确认可利用的 RCE 路径。改动小（加扩展名白名单），收益大。                                                         |
| **P-01** retention永久停摆  | 几行代码即可修（加 `reopen`）。**须与 S-P1 一起修**，否则修好也白修。                                                 |

### 第二批（P1，一个迭代内）

S-02（建群纳入 gate）、S-03（知识内容消毒）、S-04（apiKey 注册）、S-05（`without_url`）、S-06（剪贴板上限）、S-07（可执行扩展名拒绝）、P-02（agent 改getter）、S-22（正则缓存）。

### 第三批（P2，两三个迭代）

S-08~S-13、S-18、S-19、P-03~P-10、P-13、P-15、P-18、P-21、P-23。

### 第四批（P3，顺手做）

其余低危项 + 依赖升级（`happy-dom` 优先）+ CI audit 门 + `.gitignore` 补凭据规则 + PE 白名单化。

### 一条元建议

**S-P1 与 P-14 暴露了同一个根因**：`repos/*.ts` 的测试全部 mock bridge、断言 SQL 文本，**没有一条真正执行过 SQL**。`welink.spec.ts` 里`purgeMessagesBefore` 的用例名与绿色结果会让人以为"已验证"，实际验证的只是字符串拼接。

补一条用真 SQLite 跑 migration 全版本 + 各仓储方法的测试，能**一次性覆盖整类**"SQL 语法正确但组合起来违反约束"的缺陷 —— 这类问题 SQL 断言抓不到，而它们恰恰是本报告里危害最高的缺陷类型。**这项投入的性价比高于任何单点修复。**

---

## 七、需人工确认的疑点

以下几项无法单从代码判定，需结合产品决策或运行环境确认：

1. **建群外呼是否应受 safety-gate 管辖**（S-02）？gate 的定位是"消息外发风控"还是"全部对外动作风控"？无论哪种结论，都应改`safety-gate.ts:2-5` 的头部注释。
2. **"一键全停"的产品预期边界**：当前 panic 会 `runtime.stop()`，但不阻止建群、不阻止已排队的 CLI 调用。是否应包含子进程？TS 侧无杀进程通道，需 Rust 侧配合。
3. **`sediment.mode = 'auto'` 是否允许在生产启用**（S-03）？这是注入链的最后一环，代码注释已标为"显式风险"。
4. **RAG 索引的语料范围**（S-03）：若包含从群消息沉淀来的内容，`formatRetrieved` 假定"检索结果可信"的前提不成立。
5. **域名形式的 baseUrl 绕过 SSRF 闸门**（S-10）：`agent-http.ts:95-104` 只拦 IP 字面量，域名一律放行（注释明说这是为支持公网 MaaS 的设计取舍）。需确认：① 这个取舍是否刻意；② `config.json` 的文件权限是否限制为当前用户；③ 是否在宿主 `reqwest` 侧补出站白名单。
6. **apiKey 是否需要静态加密落盘**（S-04、S-13）：`registerSecret` 只解决"日志不泄漏"，未解决"配置文件明文"。是否接Windows DPAPI？
7. **`sys_env_var` 是否真有外部调用方**（S-08）？若 `sys_overview` 已覆盖所需变量，可直接删除该命令。
8. **`fs_write` 是否需要支持可执行扩展名**（S-07）？若确定不会，在 `fs_write` 层拦截比在 `shell_open` 层更早更可靠。
9. **`WATCHING_HARD_LIMIT = 1000` 与错峰总顶 30s 的匹配度**（P-04、P-07）：1000 个会话时单轮墙钟 30s + 1000 次 CLI 拉取，实际周期远超用户预期。`derivePollPlan` 会如实显示，但需确认产品是否接受这个上限。
10. **`sediment_logs` 是否有保留期清理**（对照 `welink_agent_logs` 有 `purgeAgentLogsBefore`）：若无，这是与 `AGENT_LOG_KEEP_DAYS` 对等却缺失的策略，且该表存的是完整提示词与模型回复，隐私敏感度同等。
11. **`panic = "abort"` 是否为刻意取舍**（`Cargo.toml:64`）：release 下任何 panic 都会让应用无提示消失，且 `Drop` 不运行（`shell.rs` 的托盘清理线程会留孤儿图标）。若为减小体积而选，建议在关键命令外层加 `catch_unwind`（需改为 `unwind`）换取可诊断性。
12. **`vitest.config.ts` 未纳入 typecheck 覆盖范围**：`tsconfig.json:22` 的 `include` 不含它，故 `vitest.config.ts:14` 的 `@ts-expect-error` 可能静默失效。升级 vitest 前需先纳入。

---

## 八、做得好的地方

审查中发现大量值得保留的工程实践，记录在此以免后续"优化"时被无意破坏：

**Rust 宿主层**

1. **`fs.rs` 路径校验是本次最扎实的一处**（`fs.rs:16-30`、`46-68`）：用 `contains(':')` 一刀挡掉盘符 / UNC / **NTFS ADS**（很多实现只查 `is_absolute()`，会漏 ADS）；逐 `Component` **白名单**而非黑名单；`contain_root` 用 `canonicalize` 二次复核，并在注释里清楚解释"canonicalize 对不存在路径会失败"这个坑及回溯解法 —— 这是真实踩过坑才会写的注释。
2. **`cli.rs` 的管道 deadlock 处理是教科书级正确**（`cli.rs:166-171`）：stdout/stderr 各开读线程，且 `read_limited` 里**读满上限后继续读走丢弃**而非直接 break（后者会让子进程永久卡在管道写满）。超时用 `try_wait` 轮询而非 `wait_with_output`，避免了后者一次性收全量导致的内存暴涨。
3. **`db.rs` 的 2^53 大整数处理**（`db.rs:120-129`）：超阈值转字符串而非 f64，并解释了"转 f64 会静默丢精度且调用方无从分辨"及"字符串回绑时 SQLite 按 INTEGER 亲和性转回整数"的完整推理 —— 真实业务踩坑的沉淀。
4. **`logging.rs` 对日志伪造的防御**（`logging.rs:131-151`）：level 走白名单防伪造假日志头；控制字符压成空格防 ANSI 转义清屏/伪造行结构；超长按**字符边界**截断避免切坏 UTF-8。每条都有评审编号标注原因。
5. **HTTP 响应体上限用 chunk 增量实现**（`http.rs:62-74`）：`MAX_BODY.saturating_sub` + `break` 丢弃余量，而非先 `.text()` 全量读入再截断 —— 正确的流式姿势。
6. **原子写纪律**（`storage.rs:243-255`）：先写 `.tmp` 再 `rename`，且 rename 失败时清理临时文件。
7. **迁移的数据丢失窗口分析**：`STORE_STATE` 三态机 + `with_db_exclusive` 独占连接把"复制窗口写入"和"迁移后写入旧根"两个窗口都关掉了，并明确说明该函数只有一个调用方 —— 有意的窄接口设计。
8. **`storage.rs` 有真实的单元测试**（`storage.rs:348-386`）：`MIGRATE_SUBDIRS` 清单断言防"新增子目录忘加迁移清单导致静默丢数据"，并复刻了三层嵌套的真实目录结构。

**TS 侧**

9. **SQL 参数化彻底，无一处标识符注入**；**列表与计数共用 WHERE 构造器**（`buildJobWhere`/`buildMrsWhere`/`buildInboxWhere`），从结构上排除了"分页脚与列表数字对不上"这类经典 bug。
10. **状态机原子性做对了，且是"同一条 UPDATE"而非事务凑合**：`commitDraft`（`welink.ts:645`）把 draft + 状态 + 时间戳写进同一条 UPDATE 并做乐观并发；`markSent`（`:743`）单事务三条 + `msg_uid` 幂等 + 返回 `changes[0] > 0` 让并发下只有一方记账。
11. **显式级联删除，不依赖 PRAGMA 开关**：`removeConversation`（`welink.ts:340`）单事务四条顺序正确（先子后父）；`removeJob` 的注释点明"反序会因 v1 表未声明 ON DELETE CASCADE 留下孤儿日志"。> 讽刺的是，正是这个显式处理的好习惯，在 `purgeMessagesBefore` 漏了（S-P1）。
12. **提示词的结构性注入防护**：`renderPrompt` 用**单遍 replace**而非链式 `replaceAll`（并注明"这条用例当初就是红的，抓到了这个真实漏洞"）；`sanitizeUntrusted` 三道处理都在注释里解释了**为什么**（"只降风险、不改正义语义"）；长度上限是**常量**而非配置（用户调大等于关掉这道闸）。
13. **safety-gate 的分层与幂等设计**：判定链 L0→L1→L2→L3→S8→S4→S6→S7→S1→S5→S2→S3 顺序清晰，每条都注释说明为什么在这个位置；配额只在 `onSent()` 扣减且**只在发送成功后**扣，避免"检查失败白吃配额"。
14. **`resetFuse` 里那段"曾经写错过"的注释**（`safety-gate.ts:454-465`）：记录了"`scope==='global'` 时错误清 `noUserIdFused` 会导致自回复死循环"这个真实事故，并说明为何现在刻意不清 —— 防的是"凭直觉修复"的回归。
15. **`myUserId` 为空的兜底熔断**：把"工号没填"从静默失效的过滤器变成 UI 可见的显式熔断，且**人工解除按钮刻意不解除它**，只能通过补齐配置解除 —— 把安全约束做成了不可被误操作绕过的形态。
16. **零 SELECT 的 Gate 缓存**：且明确写出"**缓存必须有写入方**，否则失效机制只是删一个永远不存在的键"，并找到了唯一的集中回填点保证不漏 —— 很多项目会在这里留下形同虚设的失效机制。
17. **双段 worker 并发模型**（`pipeline.ts`）：生成段并发 2（无副作用）、外发段严格串行 1（配额与防双发的唯一发生点）。`retryGenerate` 独立队列的注释直接写明"为什么不推回 `generateQueue`"（冲刷循环末尾的 0ms 重排会抹掉延时，导致 3 次尝试在毫秒内烧完）—— 从真实缺陷反推出的结构。
18. **`utils/poll.ts` 的量纲统一**：把"每会话错峰"与"整轮间隔"两个不同量纲的问题抽成纯函数，文件头列出四条优先级规则，并明说"无法同时满足…与其悄悄牺牲一个，不如保底保护 + 明说数字"。更关键的是**同一函数被 poller 与设置页共用**，从架构上消灭了"设置页显示 3s、实际 38s"这类不信任危机。
19. **HTTP 超时用 `AbortController` 真中止**而非 `Promise.race`：注释点明"后者的话请求仍在后台跑，本地推理服务会持续占用算力"，实现也确实在两条 settle 路径上都 `removeEventListener` —— **无监听器泄漏**。
20. **子进程参数不经 shell，无注入面**：`commands.ts` 全部用参数数组，配合 Rust 侧白名单形成 **TS + Rust 双层闸**。
21. **按操作的幂等性分级重试**：`send` 与 `create-group` **刻意不做传输层重试**（"重试可能真的发两次"、"盲目重试会拉出两个同名的群"），而 `list`/`pull` 是幂等读可重试 —— 判断正确。
22. **`verifyConnection` 类诊断通道永不 reject**：防御放在**注册表入口**而非指望每个实现者记得。
23. **`escapeLike` + `ESCAPE '\'`**：`%_\` 组合有专门单测钉住。
24. **时间戳统一走本地时区**：`utils/time.ts:5-6` 注释点明 `toISOString()` 的 UTC 陷阱（东八区凌晨会把"今天"记成昨天，日志/日期列/静默时段判定全错），全层无一处 `toISOString()` 落库。
25. **keep-alive 生命周期认知正确**：`WeLinkView.vue:152-160` 注释明确指出"曾把清理挂在 `onUnmounted` —— 在 keep-alive 下是**永不执行的死代码**"，并改为 `onActivated`/`onDeactivated`。**很多项目都会踩这个坑，这里踩过并修好了，且留了记录。**
26. **注释写"为什么"而非"是什么"**：`utils/table.ts:2-30`（为什么必须收窄类型）、`utils/b64.ts:1-16`、`vite.config.ts:96-97`、`verify.yml:1-13` —— 这类注释在半年后维护时价值最高。
27. **防误操作的交互设计**：放宽防滥发上限超默认值 2 倍需二次确认且取消即回滚；删除级联、急停解除、批量开启自动回复均有同类保护。
28. **不变量写进代码而非靠约定**：`build.mjs` 的 `--offline`、`vite.config.ts:117` 的 `chunkSizeWarningLimit: 300` 作为回归门、`build.mjs:79-86` 的版本一致性硬校验、`.gitignore:46-49` 解释为什么生成文件必须提交。
29. **分层闸门由 lint 强制**：`eslint.config.mjs:140-154` 用 `no-restricted-imports` 禁止 `views/`+`components/` 直触 `@/infra/**` 与 `@/repositories/**`，使"宿主侧也校验"在架构上成为可能。
30. **配置归一化在入口收敛**：所有配置卡都过 `normalizeXxxSettings`，越界值在入口 clamp。`CodehubSettingsCard.vue:31` 的注释"配置是可手改的 JSON，越界值必须在入口收敛"道出了这条设计原则。

---

## 附：审查方法说明

- **分域并行**：Rust 宿主（11 文件）/ infra 适配器（44 文件）/ orchestrator + stores（26 文件）/ 视图 + 工具 + 构建配置（100+ 文件），四域独立深读。
- **结论复核**：所有进入本报告的条目均已逐条打开源码核对文件与行号；对行号与描述不一致的子代理结论已在合并时修正。
- **实测验证**（非推断）：
  - **S-P1** 用 `node:sqlite` 复刻表结构与 DELETE 语句，实测输出 `FOREIGN KEY constraint failed`、剩余行数 2（一行未删）。
  - **P-01** grep 确认 `retention` 在 `runtime.ts` 的全部 6 处引用中**无复位调用**。
  - **S-02** grep `\.send(` 确认生产代码仅 `pipeline.ts:496` 一处；grep `'sending'` 确认写入点仅 `pipeline.ts:490`。
  - **依赖漏洞** `npm audit --omit=dev` 实测，未使用任何记忆中的 CVE 编号。
- **未覆盖**：`src-tauri/gen/`（生成物）、`target/`、`dist/`（构建产物）、`node_modules/`。
