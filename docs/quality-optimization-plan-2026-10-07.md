# Hello-Tauri 项目质量优化方案（2026-10-07）

- **方案日期**：2026-10-07
- **输入依据**：`docs/quality-report-2026-10-07.md`（最新质量报告，含逐条核查结论）、`docs/audit-performance-security-2026-10-07.md`（安全/性能深审）、最新源码行号核查
- **方案约束**：不修改任何源代码，仅提供优化步骤与计划

---

## 一、核查结论汇总

> 方法：对审计报告原始 24 个问题逐一打开最新源码核实，结论三类：✅ 已修复（15 项，62%）/ ⚠️ 待处理（5 项，21%）/ ⚠️ 待评估（2 项，8%）/ ⚠️ 部分修复（1 项，4%）/ ❌ 不成立（1 项，4%）。

**已修复项（共 15 项，以下列出供留档，详见质量报告 §7.2 已修复项表格）**：
S-P1 保留期清理静默失效 · S-01 CLI 白名单扩展名校验 · P-01 retention 永久停摆 · S-02 建群绕过 safety-gate · S-03 RAG/知识库未消毒 · S-05 http.rs URL 密钥泄露 · S-06 剪贴板无大小上限 · S-07 shell_open 不拒可执行 · S-09 CSV 公式注入 · S-13 .gitignore 凭据规则 · P-02 runtime.reload 不重建 Agent · P-03 harvester 双定时链泄漏 · P-04 poller.stop() 当前轮仍拉取 · P-05 jobIndex 无界增长 · P-06 消息事件全表拷贝

---

## 二、待处理问题详情

### S-04 · agent/rag apiKey 未注册 `registerSecret` 日志脱敏

**优先级：P1 · 预计工作量：1 小时**

**现状**：`normalizeAgentSettings`（`types/welink.ts:507`）和 `normalizeRagSettings`（`:648`）均提取了 `apiKey`，但两处出口均未调用 `registerSecret`。`stores/codehub.ts:90,219` 只对 `token` 注册，agent/rag 侧遗漏。

**影响**：`agent-http.ts:200-203` 拼接 `Agent 返回 HTTP ${status}：${text.slice(0,200)}` 进错误串 → 若网关 4xx 回显请求头，密钥将进入 `last_error`、`logger.error`、日志文件与 UI 运行日志面板，且不被遮蔽。`infra/agent/index.ts:42-50` 的 `cachedKey` 也常驻内存。

**优化步骤**：

1. 在 `normalizeAgentSettings` return 前加 `registerSecret(normalized.apiKey)`（`types/welink.ts:515` 段，`normalizeRagSettings` 同样处理（`:653` 段）。
2. 在 `types/welink.spec.ts` 补两条用例：分别调用两个 normalize 函数后断言 `registerSecret` 被调用，或用真实值验证 `maskSecrets` 输出。
3. `grep -rn "agent.apiKey\|rag.apiKey" src/` 确认无其他遗漏注册点。

---

### S-08 · `sys_env_var` 无白名单

**优先级：P2 · 预计工作量：2 小时**

**现状**：`sysinfo.rs:163-166` 接受任意环境变量名，无白名单、无长度限制。当前无业务消费方使用此命令，但接口存在即暴露面存在。

**影响**：前端传 `AWS_SECRET_ACCESS_KEY` / `DATABASE_URL` / `HTTP_PROXY`（组策略可能含凭据）均可读取。

**优化步骤**：

1. **方案 A（推荐，最小改动）**：将 `sys_env_var` 改为显式白名单：

   ```rust
   const ALLOWED_ENV_VARS: &[&str] = &["COMPUTERNAME", "USERNAME", "USERDOMAIN"];
   ```

   超出返回错误 `"变量名不在允许列表内"`。

2. **方案 B（更激进）**：直接删除 `sys_env_var` 命令（`sys_overview` 已覆盖 `COMPUTERNAME`/`USERNAME`）。

3. 补 Rust 单元测试：白名单项通过、非白名单项拒绝。

---

### S-10 · CSP `connect-src` 未收紧

**优先级：P2 · 预计工作量：3 小时**

**现状**：`tauri.conf.json:26` CSP 中 `connect-src 'self' http: https:` 允许 WebView 内 `fetch` 向任意域发请求。桌面模式 Agent/RAG 走宿主 `reqwest`，CSP 主要防护**浏览器降级路径**；域名形式 `baseUrl` 走应用层 SSRF 闸，但 CSP 纵深未收紧。

**优化步骤**：

1. 将 CSP `connect-src` 改为显式域名白名单（按实际部署填写）：

   ```json
   "connect-src 'self' https://llm-gateway.example.com https://rag.intranet.example.com"
   ```

2. UI 侧告警升级为保存阻断：与 `codehub-cli` `cliPathMissing` 同款处理，literal IP / 危险域名检测到后 `saveConfig` 直接拒绝并给出可行动错误。

3. 宿主 `reqwest` 侧加出站域白名单（可选，纵深防御）。

---

### S-11 · `db_migrate` `execute_batch` 不受 `guard_statement` 约束

**优先级：P2 · 预计工作量：4 小时**

**现状**：`db.rs:421-427` 迁移用 `tx.execute_batch(&migration.sql)`；`guard_statement`（`:213-222`）只覆盖 `db_execute` 路径的 4 个关键字，不拦截 `execute_batch`。迁移 SQL 来自仓库内 TS（可信），真实风险为中，但防线不一致是架构缺陷。

**优化步骤**：

1. 新增 `guard_statements(sql)` 函数：剥注释+字面量后按分号分句，逐条调用 `guard_statement`，任一命中即整体拒绝。
2. `db_migrate` 改用 `guard_statements` 逐条检查 + `execute`（与 `db_execute` 同款防线）。
3. 将 `FORBIDDEN_SQL` 下沉到 TS 侧注释（策略层归属业务代码），Rust 只保留"单语句"硬约束。
4. 补 Rust 单元测试：迁移 SQL 含 ATTACH / DROP 时应被拒绝。

---

### S-12 · token 长度侧信道与 argv 暴露

**优先级：P1（立即可做）/ P3（通道级）· 预计工作量：15 分钟 + 1 天**

**现状**：`exec.ts:38` 脱敏后仍输出 `[token 已省略 ${arg.length} 字]`，精确到字符；`codehub-cli.ts:50` 以 `--token <值>` 传参，Windows 同机其他进程可用 `Get-CimInstance Win32_Process` 读到完整命令行。

**优化步骤**：

1. **立即可做（15 分钟）**：`exec.ts:38` 改为 `out.push('[token 已省略]')`，去掉 `${arg.length}`。
2. **通道级改动（需 CLI 对接 SOP 验证）**：查阅 `docs/cli-integration-adaptation-2026-10-04.md`，评估 stdin 传 token 或环境变量 `CODEXHUB_TOKEN` 的可行性；对接真实 CLI 时将 argv 暴露列入显式安全评审。

---

## 三、性能项

### P-07 · `view.ts` 启动恢复串行 N+1 IPC

**优先级：P2 · 预计工作量：4 小时**

**现状**：`stores/welink/view.ts:233` 启动恢复时串行调用多个 IPC 命令。`bootstrap` 阶段"装载配置 + 拉取会话列表 + 拉取监控列表"三路互不依赖。

**优化步骤**：

1. 识别可并行节点，改 `Promise.all` 并行；`pipeline.enqueue` 依赖 `poller` 初始化完成的部分保持串行。
2. 在 `bootstrap.spec.ts` 加时序断言，确认并行后冷启动耗时下降。

---

### P-10 · `table` store `stats` computed 全表重算

**优先级：P3 · 预计工作量：0 小时（记录假设）**

**现状**：`stores/table.ts:52-61` `stats` computed 在任意行变更时全量 `filter + reduce`。

**决策**：当前数据规模在千级以内（`PURGE_MAX_ROUNDS = 20` × `PURGE_BATCH_SIZE = 500` = 单日最多清理 1 万行；实际用户规模在千级），Vue computed 响应式粒度足够，当前不优化。

**记录假设**：在 `table.ts` 文件头补充注释 `// stats 全量重算假设：数据规模 ≤ 5000 行；超出时需拆为增量维护（total/active/amount 各自维护独立 ref）`。

---

### P-11 · `InboxTab` 历史消息全量重拉

**优先级：P2 · 预计工作量：4 小时**

**现状**：`InboxTab.vue:83-86` 每次「加载更早」`detailLimit += 100` 后全量 `selectConversation(convId, detailLimit)`；历史放大时单次拉取行数线性增长。

**优化步骤**：

1. 仓储层 `selectMessages` 加 `afterPk` 参数（基于主键精确分页，替代 `after` 时间戳）。
2. `selectConversation` 返回 `{ messages, hasMore }`；UI 改为增量追加 `detail.value = [...detail.value, ...newMessages]`。
3. `hasMore = false` 时隐藏「加载更早」按钮并提示"已加载全部"。

---

## 四、优化阶段路线图

### 阶段一：立即可做（本迭代，< 1 天）

| 优先级 | 问题                                            | 预计工作量 | 改动文件                       |
| ------ | ----------------------------------------------- | ---------- | ------------------------------ |
| P1     | **S-12** token 脱敏去精确长度输出               | 15min      | `src/infra/codehub/exec.ts:38` |
| P1     | **S-04** agent/rag apiKey 注册 `registerSecret` | 1h         | `src/types/welink.ts` 2 处     |

### 阶段二：下个迭代（1-2 周）

| 优先级 | 问题                                          | 预计工作量 |
| ------ | --------------------------------------------- | ---------- |
| P2     | **S-08** `sys_env_var` 白名单                 | 2h         |
| P2     | **S-10** CSP `connect-src` 收紧               | 3h         |
| P2     | **P-07** 启动恢复 N+1 IPC 并行化              | 4h         |
| P2     | **P-11** `InboxTab` 增量追加                  | 4h         |
| P2     | **S-11** `db_migrate` `guard_statements` 加固 | 4h         |

### 阶段三：中期（按需）

| 优先级 | 问题                                 | 触发条件                    |
| ------ | ------------------------------------ | --------------------------- |
| P3     | **P-10** table stats 增量维护        | 数据 >5000 行或用户反馈卡顿 |
| P3     | **S-12** token 传参改 stdin/环境变量 | CLI 对接 SOP 确认可行       |

---

## 五、回归测试策略

### 5.1 必须补的集成测试

**真实 SQLite 集成测试**（mock bridge 无法捕捉 SQL 约束类缺陷）：

- 文件：`src/infra/db/repos/welink-sqlite-integration.spec.ts`（现有）
- 新增用例：`purgeMessagesBefore` 在存在外键引用时的实际删除行数验证（插入消息 → 插入引用该消息的 job → 调用 purge → 断言未引用消息被删、被引用消息保留）

### 5.2 安全类测试加固

| 测试覆盖                | 当前状态                                | 建议                               |
| ----------------------- | --------------------------------------- | ---------------------------------- |
| `cli.rs` 白名单         | ✅ 8 条 Rust 测试                       | 保持                               |
| `shell.rs` 扩展名黑名单 | ✅ 3 条 Rust 测试                       | 保持                               |
| `prompt.ts` 占位符注入  | ✅ 单测钉住                             | 保持                               |
| `safety-gate.ts` 五要素 | ⚠️ 缺建群维度                           | 补建群拦截用例                     |
| `registerSecret` 遮蔽   | ✅ `logger.spec.ts` + `secrets.spec.ts` | S-04 修复后补 agent/rag 用例       |
| `http.rs` 错误串脱敏    | ⚠️ 无 Rust 单元测试                     | 补 `describe_transport_error` 用例 |
| `sysinfo.rs` 白名单     | ⚠️ 无（待修）                           | S-08 修复时同步补                  |

---

## 六、执行优先级矩阵

```
影响 \ 工作量
         小(<2h)    中(2-8h)    大(>1天)
高       ┌─────────┬─────────────┬──────────┐
        │ S-04    │ S-10        │          │
        │ S-12(1) │ S-11        │          │
        │ S-08    │ P-07        │          │
中       ├─────────┼─────────────┤          │
        │ P-10(记)│ P-11        │          │
低       └─────────┴─────────────┴──────────┘
```

**建议执行顺序**：S-04 → S-12(立即可做) → S-08 → S-10 → S-11 → P-07 → P-11 → P-10 按需

---

_本方案基于 2026-10-07 最新源码核查，所有已修复项已从待处理列表移除，仅保留真实未解决问题。_
