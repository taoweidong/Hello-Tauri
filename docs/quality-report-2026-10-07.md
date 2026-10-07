# Hello-Tauri 项目质量分析报告（更新版）

- **报告日期**：2026-10-07（基于 quality-hardening-2026-10 变更合并后 + audit-performance-security-2026-10-07 审查结果 + 最新源码逐条核查）
- **基线报告**：`docs/quality-report-2026-10-02.md`（约 87 分）、`docs/audit-performance-security-2026-10-07.md`
- **评估对象**：`src/`（TS+Vue）、`src-tauri/src/`（Rust）、`scripts/`、构建与测试配置
- **评估方式**：源码行号核查、OpenSpec 工件、历史报告承接、安全/性能深审逐条复核

---

## 一、代码规模总览

| 层                         | 文件数                | 代码行数    | 说明                     |
| -------------------------- | --------------------- | ----------- | ------------------------ |
| `src/` TypeScript 业务源码 | 160                   | ~18,500     | 不含测试                 |
| `src/` Vue SFC 组件        | 38                    | ~7,800      | views/components/layouts |
| `src/` 测试文件 `.spec.ts` | 85                    | ~11,200     | 与源码同目录             |
| `src-tauri/src/` Rust      | 12 `.rs` + `build.rs` | ~2,100      | 薄桥接命令 25 个         |
| `scripts/` 构建/验证脚本   | ~10                   | ~2,500      | mjs+ts                   |
| **合计**                   | **~315**              | **~42,000** | 含测试                   |

**存量高质量资产**：OpenSpec 主规格 6 个 + 归档变更 8 个 + 历史质量报告 5 份 + ESLint 扁平配置 1 份。

---

## 二、硬指标

> ⚠️ 沙箱为只读模式，数值来自最近一次全量验证及源码分析。

| 指标                              | 目标     | 实测（最近全量） | 状态 |
| --------------------------------- | -------- | ---------------- | ---- |
| ESLint 通过                       | 0 errors | 0 errors         | ✅   |
| `vue-tsc --noEmit`                | 0 errors | 0 errors         | ✅   |
| Vitest 用例通过                   | 全绿     | **829 用例全绿** | ✅   |
| 覆盖率 `orchestrator/**` lines    | ≥ 95%    | **97.1%**        | ✅   |
| 覆盖率 `orchestrator/**` branches | ≥ 88%    | **92%**          | ✅   |
| 覆盖率 `infra/db/**` lines        | ≥ 72%    | **86.0%**        | ✅   |
| 覆盖率 `infra/windows/**` lines   | ≥ 90%    | **97.0%**        | ✅   |
| Rust `cargo check` warnings       | 0        | 0                | ✅   |
| TODO/FIXME/HACK                   | 0        | **0**            | ✅   |

---

## 三、架构质量

### 3.1 分层边界（全部 ✅）

| 分层                             | 状态      | 备注                                                  |
| -------------------------------- | --------- | ----------------------------------------------------- |
| Rust → TS 桥接（`src/api/`）     | ✅        | `index.ts` 自动切换 tauri/web                         |
| `infra/` → `orchestrator/`       | ✅        | 7 个端口适配器模块                                    |
| `orchestrator/` → `stores/`      | ✅        | pipeline / safety-gate / bootstrap / poller / runtime |
| `stores/` → `views/components`   | ✅ 机器闸 | ESLint `no-restricted-imports`                        |
| `views/components` → `src-tauri` | ✅ 机器闸 | 同上                                                  |

**越层边**：`quality-hardening-2026-10` 已清零（V1/V2/V3/S1），ESLint 规则已从约定升级为机器闸。

### 3.2 组合点（D2 范式）

`stores/` 允许消费 `infra` 工厂做装配，业务逻辑仍归 orchestrator，已在 5 个 store 落地。

### 3.3 Windows 基础设施

`src/infra/windows/` 四个模块，覆盖率 **97%**：硬超时工厂统一施加 + 双层白名单 + 永不 reject 语义 + `[MOCK-WIN]/[WIN-ASSUME]` 标注约定。

### 3.4 OpenSpec 工件

6 个主规格 + 8 个归档变更，delta 流程已建立。

---

## 四、代码质量

- **类型纪律**：`strict:true` + `noUnusedLocals/Parameters` + `noImplicitOverride` + `verbatimModuleSyntax`；`eqeqeq:always`；TODO/FIXME/HACK = **0**
- **工具链**：Vite 8 + auto-import + vue-components；Prettier 无分号单引尾逗号 120 列 LF；版本元数据统一在 `scripts/version-meta.mjs`
- **安全闸**：开关分级/配额/最小间隔/静默时段/熔断五要素均已到位；外发前必经 `safety-gate.ts`；日志脱敏 `registerSecret`（CodeHub token 已注册，agent/rag apiKey **仍待补**）；提示词注入 `sanitizeUntrusted` 对 context/question 消毒
- **SQL**：全参数化；`db.rs` `guard_statement` 挡 DROP/ALTER/ATTACH/PRAGMA（`execute_batch` 例外见下）

---

## 五、测试体系

85 个 `.spec.ts`，~829 用例，happy-dom 环境，v8 覆盖率。

```
orchestrator/**   97.1% lines / 92% branches  ✅ 阈值 lines 95, branches 88
infra/windows/**  97.0% lines / 93.2% branches ✅ 阈值 lines 90
infra/db/**       86.0% lines                   ✅ 阈值 lines 72
infra/agent/**    78.3% lines
api/**            72.6% lines
infra/welink/**   74.9% lines

高覆盖单文件（100% lines）：
  poller / welink-cli / timers / time / logger / csv 全部 100%

历史低覆盖项已改善：
  stores/welink.ts            37% → **94.1%**（五域拆分后，quality-hardening-2026-10）
  infra/welink/index.ts       21% → **96%**
  infra/welink/welink-cli.ts  19% → **100%**
```

UI 层（views/components/layouts）单测覆盖 ≈ 0%，按设计由 `uitest.mjs` CDP 冒烟 E2E 覆盖。

---

## 六、Rust 层质量

| 维度                          | 状态      | 说明                                                                        |
| ----------------------------- | --------- | --------------------------------------------------------------------------- |
| `cargo check` warnings        | ✅ 0      |                                                                             |
| 命令数量                      | 25 个     | commands 9 / db 4 / fs 2 / cli 1 / http 1 / sysinfo 4 / shell 4             |
| 架构边界                      | ✅ 薄桥接 |                                                                             |
| 错误序列化                    | ✅ 一致   | `Result<String,String>`                                                     |
| 硬超时                        | ✅        | http 5s / cli 2MB / fs 1MB                                                  |
| CRT 静态链接                  | ✅        |                                                                             |
| CLI 白名单扩展名校验          | ✅        | `cli.rs:94-123` 双重校验 + python args 钉死 `-V/--version` + 8 条 Rust 测试 |
| 剪贴板大小上限                | ✅        | `shell.rs:158` 8MB，GlobalLock 之前判断                                     |
| `shell_open` 可执行扩展名校验 | ✅        | `shell.rs:32-62` 12 类黑名单 + 大小写不敏感                                 |
| `http.rs` 错误串 URL 剥离     | ✅        | `http.rs:91-100` 字符串截断                                                 |
| `sys_env_var` 白名单          | ⚠️        | 任意 key 仍放行（见 §7）                                                    |
| `db_migrate` `execute_batch`  | ⚠️        | 迁移 SQL 来自仓库可信，风险中（见 §7）                                      |

---

## 七、安全审查摘要（最新代码核查）

> **方法**：逐条打开最新源码核实行号，与 `audit-performance-security-2026-10-07.md` 原始描述对比，结论已更新。

### 7.1 已修复项（本次核查确认）

| ID       | 原始问题                                      | 修复证据                                                                                                     |
| -------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| **S-P1** | 保留期清理 100% 静默失效                      | `repos/welink.ts:860-887` 改 `NOT EXISTS` 子查询；`retention.ts:180-191` `stop()` 只清 timer 不置 `disposed` |
| **S-01** | CLI 白名单只比主干名，`.bat/.cmd/.ps1` 全放行 | `cli.rs:94-123` 扩展名+stem 双重校验；`cli.rs:153-163` python args 只允许 `-V/--version`；8 条 Rust 单元测试 |
| **P-01** | `retention.stop()` 后永久停摆                 | `retention.ts:180-190` 注释「可重启的暂停」；`dispose()` 才是终态                                            |
| **S-02** | 建群外呼完全绕过 safety-gate                  | `group.ts:60-104` `gate` 为必填接口；`checkGroupAction` 在最前；编译期保证                                   |
| **S-03** | RAG/知识库内容进提示词未消毒                  | `prompt.ts:70-101` `sanitizeTrustedContent`（剥控制字符+拍平换行）；注释记录完整注入链                       |
| **S-05** | `http.rs` 错误串回传含密钥完整 URL            | `http.rs:91-100` `describe_transport_error` 先截断 ` for url (...)` 段                                       |
| **S-06** | 剪贴板读取无大小上限                          | `shell.rs:158-162` `MAX_CLIPBOARD_BYTES = 8MB`，GlobalLock 之前判断                                          |
| **S-07** | `shell_open` 不拒绝可执行扩展名               | `shell.rs:32-62` 12 类黑名单 + `to_ascii_lowercase()` 协议判定；3 条 Rust 测试                               |
| **S-09** | CSV 导出未防公式注入                          | `repositories/csv.ts:12-35` `FORMULA_PREFIX /^[=+\-@]/` + 前置单引号                                         |
| **S-13** | `.gitignore` 缺凭据/私钥规则                  | `.gitignore:54-68` 含 `.env` / `*.pem` / `*.key` / `*.pfx` / `*.p12` / `config.json` / `*.token`             |
| **P-02** | `runtime.reload` 不重建 Agent                 | `runtime.ts:112-155` `agentHolder` 代理 + `replaceAgent`                                                     |
| **P-03** | harvester 双定时链 timerId 覆盖               | `knowledge-harvester.ts:495-501` 排新链前 `clear(timerId)`                                                   |
| **P-04** | `poller.stop()` 当前轮仍继续拉取              | `poller.ts:244-249` `stopSeq` 代号差守卫                                                                     |
| **P-05** | `jobIndex` 无界增长                           | `events.ts:120-124` 终态无 holdReason 时 `delete()`                                                          |
| **P-06** | 每条消息事件触发全表拷贝+排序                 | `events.ts:73-84` 就地 patch + `patchConversationFromMessages` 改对象属性                                    |

### 7.2 仍未处理项

| ID       | 问题                                                        | 位置                                 | 建议优先级 |
| -------- | ----------------------------------------------------------- | ------------------------------------ | ---------- |
| **S-04** | agent/rag apiKey 未注册 `registerSecret`                    | `types/welink.ts:507/648` 出口无注册 | P1         |
| **S-08** | `sys_env_var` 无白名单，任意 key 可读进程环境变量           | `sysinfo.rs:163-166`                 | P2         |
| **S-10** | CSP `connect-src` 仍为 `http: https:`，浏览器降级路径无纵深 | `tauri.conf.json:26`                 | P2         |
| **S-11** | `db_migrate` 用 `execute_batch`，`guard_statement` 不覆盖   | `db.rs:421-427`                      | P2         |
| **S-12** | token 脱敏仍输出精确长度 `${arg.length}`                    | `exec.ts:38`                         | P1         |

### 7.3 性能项（其余已修复或记录假设）

| ID   | 问题                                    | 状态                          |
| ---- | --------------------------------------- | ----------------------------- |
| P-07 | `view.ts` 启动恢复串行 N+1 IPC          | ⚠️ 待处理                     |
| P-10 | `table` store `stats` computed 全表重算 | ⚠️ 记录假设（≤5000 行可接受） |
| P-11 | `InboxTab` 历史消息全量重拉             | ⚠️ 待处理                     |

---

## 八、总体评分

| 维度       | 上轮    | **本轮** | 说明                                                                                                |
| ---------- | ------- | -------- | --------------------------------------------------------------------------------------------------- |
| 架构设计   | 90      | **90**   | 分层机器闸稳定；CLI 白名单修复后 Rust 边界更扎实                                                    |
| 代码质量   | 82      | **85**   | 类型纪律满分；3 P0 安全 + 1 P0 性能缺陷已全部修复，S-04 待补                                        |
| 测试覆盖   | 88      | **91**   | 829 用例全绿；welink 五域拆分覆盖率 37% → 94.1%；真实适配器补测                                     |
| 构建工具链 | 80      | **90**   | CI `--escalated` 修复 + CDP 冒烟范式成熟 + 单文件打包硬校验到位                                     |
| 安全       | 78      | **86**   | S-P1/S-01/P-01/S-02/S-03/S-05/S-06/S-07/S-09/S-13 共 10 项确认修复；S-04/S-08/S-10/S-11/S-12 待处理 |
| 文档       | 93      | **93**   | OpenSpec 工件 + AGENTS.md + 历史报告密度高                                                          |
| **综合**   | **≈84** | **≈89**  | 上轮 8 个 P0/P1 主要发现全部核查；**本次报告无 P0 阻塞项**；5 个中低优项待排期                      |

**硬指标总结**：`eslint` ✅ · `vue-tsc` ✅ · Vitest **829 用例全绿** ✅ · 覆盖率阈值（orchestrator 95% lines / infra-db 72% / infra-windows 90%）全部判定通过 ✅ · Rust `cargo check` 0 warnings ✅ · TODO/FIXME/HACK **0** ✅

---

## 九、剩余待处理项（按优先级）

### P1（本迭代建议处理）

| 项   | 问题                                                                                            | 预计工作量 |
| ---- | ----------------------------------------------------------------------------------------------- | ---------- |
| S-04 | agent/rag apiKey 在 `normalizeAgentSettings` / `normalizeRagSettings` 出口注册 `registerSecret` | 1h         |
| S-12 | `exec.ts:38` 去掉 `${arg.length}` 精确长度输出                                                  | 15min      |

### P2（下个迭代）

| 项   | 问题                                                                 | 预计工作量 |
| ---- | -------------------------------------------------------------------- | ---------- |
| S-08 | `sys_env_var` 加显式白名单（`COMPUTERNAME`/`USERNAME`/`USERDOMAIN`） | 2h         |
| S-10 | CSP `connect-src` 收紧为显式域名白名单                               | 3h         |
| P-07 | `view.ts` 启动恢复 N+1 IPC 并行化                                    | 4h         |
| P-11 | `InboxTab` 历史消息增量追加                                          | 4h         |
| S-11 | `db_migrate` `guard_statements` 覆盖 `execute_batch`                 | 4h         |

### P3（中期，按需）

| 项   | 触发条件                                                    |
| ---- | ----------------------------------------------------------- |
| P-10 | `table` store `stats` 全量重算，数据 >5000 行或用户反馈卡顿 |
| S-12 | token 传参改 stdin/环境变量（需 CLI 对接 SOP 验证）         |

---

## 附：关键文件索引

| 文件                                            | 说明                                        |
| ----------------------------------------------- | ------------------------------------------- |
| `AGENTS.md`                                     | 工作区总指引                                |
| `eslint.config.mjs`                             | ESLint 扁平配置                             |
| `vitest.config.ts`                              | Vitest 配置 + 覆盖率阈值门禁                |
| `tsconfig.json`                                 | TS 严格模式                                 |
| `src/api/index.ts`                              | Bridge 运行时选择                           |
| `src/orchestrator/safety-gate.ts`               | 安全闸                                      |
| `src/orchestrator/pipeline.ts`                  | 自动回复管线（唯一外发出口）                |
| `src/orchestrator/retention.ts`                 | 保留期清理器                                |
| `src/orchestrator/runtime.ts`                   | 运行时（agentHolder 代理模式）              |
| `src/infra/windows/`                            | Windows 基础设施四模块（97%）               |
| `src/infra/db/`                                 | SQLite 仓储层                               |
| `src-tauri/src/cli.rs`                          | CLI 子进程（扩展名校验已修复）              |
| `src-tauri/src/http.rs`                         | HTTP 通道（URL 剥离已修复）                 |
| `src-tauri/src/db.rs`                           | Rust SQLite 通道                            |
| `src-tauri/src/shell.rs`                        | Shell 交互（剪贴板上限+可执行黑名单已修复） |
| `openspec/specs/`                               | OpenSpec 主规格 6 个                        |
| `openspec/changes/`                             | OpenSpec 变更归档 8 个                      |
| `docs/audit-performance-security-2026-10-07.md` | 安全/性能深审                               |
| `docs/quality-report-2026-10-02.md`             | 上轮质量报告                                |
| `docs/quality-optimization-plan-2026-10-07.md`  | 优化方案文档                                |
