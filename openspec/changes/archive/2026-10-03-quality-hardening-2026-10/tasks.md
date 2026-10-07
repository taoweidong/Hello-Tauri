# Tasks

## 1. 横切件提取（design D5）

- [x] 1.1 新建 `src/utils/async-guard.ts`：`withHardTimeout(task, timeoutMs, onTimeout)`
      与 `foldRejection(task, onFailure)` 两个原语 + 同目录 spec（超时触发/定时器清除/
      折叠传播三类用例，fake timers）
- [x] 1.2 `src/infra/envcheck/port.ts` 的 `withHardTimeout` 改为薄引用 async-guard
      （结果折叠语义经参数表达）；`envcheck` 现有 spec **断言不改一行**全绿
- [x] 1.3 `src/infra/windows/index.ts` 的 `strictTimeout`/`foldedTimeout` 改为薄引用；
      `windows` 现有 spec 全绿；`npm run lint && npm run typecheck` 通过

## 2. welink store 拆分与 S1 治理（design D1/D2）

- [x] 2.1 新建 `src/orchestrator/welink-storage.ts`：`ensureWelinkStorage()`（迁移幂等）+ `getWelinkRepo()`（懒建单例，浏览器模式内存实现），含同目录 spec
- [x] 2.2 展示常量迁移：`HOLD_REASON_LABEL`/`JOB_STATUS_LABEL`/`SKIP_REASON_LABEL`/
      `CONVERSATION_PAGE_LIMIT` 移至 `src/types/welink.ts`，`infra/db/ports` 原地
      re-export；既有引用方测试全绿
- [x] 2.3 `src/stores/welink.ts` → `src/stores/welink/`：`index.ts`（facade + 日志旁路，
      导出面不变）、`events.ts`、`view.ts`、`control.ts`、`aggregate.ts`；store 的
      `repo()` 与 `dbMigrateAll` 改走 welink-storage 网关（S1 消失）
- [x] 2.4 测试迁移与补测：现有 `welink.spec.ts` 按域迁入 `src/stores/welink/*.spec.ts`
      断言不改；events/aggregate/view 纯函数新增直测，`stores/welink` 聚合
      lines ≥ 70%；`npm run check` 全绿
- [x] 2.5 AGENTS.md 分层小节补「组合点例外」口径（store 可消费 infra 工厂作装配点，
      业务逻辑归 orchestrator）

## 3. UI 越层边治理与 ESLint 闸门（design D4）

- [x] 3.1 V1：`SettingsCard.vue:20` 的 `createAgentProbe` 直构改为经由 store 暴露的
      探测入口（app 或 welink store 承接），组件不再 import `@/infra/**`
- [x] 3.2 V3：`TableCrudView.vue:9` 的 CSV 导出改走 table store 暴露的方法，
      `repositories/csv.ts` 逻辑不动
- [x] 3.3 V2 清零核验：组件层不再有 `@/infra/**`/`@/repositories/**` import
      （grep 清单贴入任务备注）
- [x] 3.4 `eslint.config.mjs`：`views/**`+`components/**` 禁 `@/infra/**` 与
      `@/repositories/**`（no-restricted-imports patterns，error 级）；
      `npm run lint` 全绿即闸门生效

## 4. welink 组件瘦身（design D3）

- [x] 4.1 `MessagesTab.vue`（832 行）拆出会话列表 / 任务列表 / 右栏详情三个子组件，
      子组件纯展示、逻辑留 store；`npm test` 全绿 + `npm run build` 通过
- [x] 4.2 `SettingsCard.vue`（890 行）按设置分区拆子组件；`npm test` 全绿
- [x] 4.3 uitest 冒烟：`npm run uitest` 通过（打包产物 E2E 确认 WeLink 页与设置页
      交互无回归）

## 5. 真实适配器 wrapper 补测（proposal 第一批）

- [x] 5.1 `src/infra/welink/welink-cli.ts`（19%）补测：注入 Bridge 桩覆盖 invoke 组装、
      base64 解码、错误分类路径
- [x] 5.2 `src/infra/welink/index.ts`（21%）补测：端口工厂平台切换 / mock 强制 / 缓存
      语义用例；`npm run test:coverage` 中 `infra/welink` lines ≥ 85%

## 6. 小额补测（proposal 第三批）

- [x] 6.1 `orchestrator/timers.ts`（50%）、`utils/time.ts`（54%）、`utils/logger.ts`
      （69%）、`repositories/csv.ts`（0%）各补直测至 lines ≥ 85%；
      `npm run check` 全绿

## 7. 覆盖率阈值抬线（design D7）

- [x] 7.1 `vitest.config.ts`：新增 `src/infra/windows/**` 阈值（lines/statements 90、
      functions 75、branches 88）；orchestrator 抬至 95/95/90/88；
      `npm run test:coverage` 判定通过

## 8. 存量能力 spec 补齐（design D6）

- [x] 8.1 `openspec/specs/welink-auto-reply/spec.md`：轮询→草稿→安全闸→外发链
      （L0-L3/O7/O11/S8、pending→ready、急停落盘），需求逐条标注来源测试文件；
      `openspec validate --specs` 通过
- [x] 8.2 `openspec/specs/welink-group-creation/spec.md`：pending 留痕 / 原子回写 /
      禁传输层重试；同上校验
- [x] 8.3 `openspec/specs/data-storage-lifecycle/spec.md`：数据根 / 引导文件 / 迁移 /
      日志保留；同上校验

## 9. 复验与收尾

- [x] 9.1 复验上轮报告 3.8（监控页筛选分页）：桌面 dev 页面人工复验；复现则修复
      （筛选变化重置页码 + store 层测试）并在本变更内记录，不复现则记录结论
- [x] 9.2 `docs/quality-report-2026-10-02.md` 优化项逐项标注核销状态；
      `npm run check`（lint + typecheck + test）全绿——会话收尾门禁
