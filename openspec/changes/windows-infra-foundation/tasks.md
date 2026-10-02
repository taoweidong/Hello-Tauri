# Tasks

## 1. Rust 薄桥接命令与依赖

- [x] 1.1 `src-tauri/Cargo.toml` 为 windows-sys 增补 feature（Registry、
      Storage_FileSystem、NetworkManagement_IpHelper/Ndis、Networking_WinSock、
      UI_Shell、UI_WindowsAndMessaging、Graphics_Gdi、System_DataExchange/Ole/
      Memory/Com/LibraryLoader）；**不新增 crate**（内网缓存约束，见 design D3 修订）；
      `cargo check` 通过
- [x] 1.2 新建 `src-tauri/src/sysinfo.rs` 四个只读命令：`sys_overview`（OS 版本/架构/
      主机名/当前用户/数据根）、`sys_env_var`（按名读环境变量，缺失返回 None）、
      `sys_disks`（GetDiskFreeSpaceExW）、`sys_adapters`（GetAdaptersAddresses），
      输出 serde camelCase；`cargo check` 通过
- [x] 1.3 新建 `src-tauri/src/shell.rs`：`shell_open`（ShellExecuteW "open" 动词，
      支持 URL/文件/目录，目标不存在报错，线程内 COM 初始化）、
      `clipboard_read` / `clipboard_write`（windows-sys 剪贴板 API，CF_UNICODETEXT，
      打开失败短重试）、`notify_send`（Shell_NotifyIconW 托盘气球提示，延迟后台
      线程清理图标）；`cargo check` 通过
- [x] 1.4 `src-tauri/src/cli.rs` 扩展 `ALLOWED_STEMS`：逐项放行 `systeminfo`、
      `ipconfig`、`tasklist`、`where`、`whoami`、`hostname`、`nslookup`、`ping`
      并注释各自用途；确认 welink/python 项与现有注释未被改动
- [x] 1.5 `src-tauri/src/lib.rs` 注册全部新命令；`cargo check` 通过，
      `npm run tauri:dev` 启动无注册冲突报错

## 2. Bridge 契约扩展

- [x] 2.1 `src/types/index.ts` 新增类型：`SysOverview`、`SysDisk`、`SysAdapter`、
      `ProbeResult<T>`（`{ ok: true, data } | { ok: false, reason, detail? }`）、
      `ClipboardOutcome`、`NotifyOutcome` 等；`npm run typecheck` 通过
- [x] 2.2 `src/api/types.ts` Bridge 接口新增八个方法：`sysOverview` / `sysEnvVar` /
      `sysDisks` / `sysAdapters` / `shellOpen` / `clipboardRead` / `clipboardWrite` /
      `notifySend`，注释写明「永不 reject」契约（命令执行不新增方法，沿用 `cliRun`）；
      typecheck 通过
- [x] 2.3 `src/api/tauri.ts` 实现八个新方法（invoke 到 1.2/1.3 的 Rust 命令，
      异常在方法内折叠为结果对象）；typecheck 通过
- [x] 2.4 `src/api/web.ts` 浏览器等价实现：系统信息返回 `[MOCK-WIN]` 标注的模拟
      数据；剪贴板走 `navigator.clipboard`、通知走 `Notification` API、URL 打开走
      `window.open`，能力缺失/权限拒绝返回与桌面一致的结果结构；typecheck 通过
- [x] 2.5 `src/api/index.spec.ts` 扩展契约测试：八个新方法的平台选择与双侧实现
      语义断言；`npm test` 中 Bridge 相关用例全绿

## 3. infra/windows：端口、命令注册表与模拟替身

- [x] 3.1 `src/infra/windows/port.ts`：结果对象类型 + `WindowsInfraPort` 接口 +
      模块级硬超时常量；typecheck 通过
- [x] 3.2 `src/infra/windows/registry.ts`：初始登记 8 条只读诊断命令（程序名/参数
      模板/用途/超时预算，默认 5s），提供按 ID 取项与未登记校验；参数语法逐条
      `[WIN-ASSUME]` 标注；`registry.spec.ts` 覆盖登记项完整性与校验分支
- [x] 3.3 `src/infra/windows/mock.ts`：`[MOCK-WIN]` 全接口模拟实现（可注入延迟与
      故障场景，浏览器调试 + 测试替身两用）；`mock.spec.ts` 覆盖关键分支
- [x] 3.4 AGENTS.md 标注约定补 `[MOCK-WIN]` / `[WIN-ASSUME]` 两条目；
      `grep -rn "MOCK-WIN\|WIN-ASSUME" src/` 输出符合约定

## 4. infra/windows：命令执行适配器

- [x] 4.1 `src/infra/windows/command-exec.ts`：按注册表项执行（校验登记 → 组装
      参数 → `bridge.cliRun` → base64 解码 → 结果结构）；未登记 ID 直接拒绝且
      不触碰 Bridge；`command-exec.spec.ts` 覆盖成功/非零退出/超时/未登记/白名单
      拒绝五类分支（注入 Bridge 桩）
- [x] 4.2 GBK 兜底解码与截断标志透传用例（复用 `utils/b64.ts`）；`npm test`
      相关用例全绿

## 5. infra/windows：系统信息适配器

- [x] 5.1 `src/infra/windows/sysinfo.ts`：概要/环境变量/磁盘/网络四探测，宿主异常
      折叠为 `{ ok: false }`（永不 reject）；`sysinfo.spec.ts` 以注入 Bridge 桩覆盖
      正常/异常/变量缺失/空字段分支；`npm test` 全绿

## 6. infra/windows：Shell 交互适配器

- [x] 6.1 `src/infra/windows/shell.ts`：`openWithDefault` / `readClipboard` /
      `writeClipboard` / `notify` 四方法，异常折叠永不 reject；`shell.spec.ts`
      覆盖成功/目标不存在/剪贴板非文本/通知不可用分支（注入 Bridge 桩）；
      `npm test` 全绿

## 7. 工厂与模块收口

- [x] 7.1 `src/infra/windows/index.ts` 工厂：按平台切换真实适配器/mock，统一施加
      硬超时包装与异常折叠（与 `createEnvChecks` 同款防御位置）；
      `index.spec.ts` 覆盖模式选择、硬超时（fake timers）、包装后永不 reject
- [x] 7.2 模块导出面收敛（`index.ts` 为唯一出口，内部文件不外泄类型之外的实现）；
      `npm run lint` 与 `npm run typecheck` 通过

## 8. 集成验证与文档收口

- [x] 8.1 AGENTS.md 同步：Rust 命令清单（16 → 实际数量）、`ALLOWED_STEMS` 白名单
      说明、`src/api/` 与架构边界小节核对新方法无遗漏
- [x] 8.2 桌面冒烟（`npm run tauri:dev`）：逐条执行注册表 8 条命令、系统概要/
      磁盘/网络探测、剪贴板写读、一次系统通知、一次 shellOpen（URL 与目录各一），
      结果与 GBK 中文输出可读性记录到变更目录冒烟记录
- [x] 8.3 `npm run check`（lint + typecheck + test）全绿——会话收尾门禁；
      若触及覆盖率基线再核对 `npm run test:coverage`
