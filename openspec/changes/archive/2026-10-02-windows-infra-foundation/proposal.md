# Proposal

## Why

应用以单文件离线 exe 形态运行在 Windows 内网环境，目前与宿主的交互只有三条窄通道：
welink-cli/python 子进程（白名单）、存储根内文件、SQLite。后续可预见的功能——更深入的
环境诊断、运维脚本集成、桌面级交互（剪贴板/通知/默认程序打开）——各自临时在 Bridge 上
开洞，缺乏统一的 Windows 基础设施层。现在按既有端口-适配器约定把「执行系统命令、探测
系统状态、与 Shell 交互」三类基础能力一次性搭好，后续功能拓展只加注册项、不动架构。

## What Changes

- 新增 `src/infra/windows/` 端口-适配器模块（port + mock + bridge 适配器 + 工厂），
  完全遵循 envcheck 已验证的模式：永不 reject、硬超时兜底、mock/真实按平台切换。
- Bridge 扩展三组方法（tauri.ts / web.ts 双侧契约一致实现）：
  - **系统命令执行**：在受控前提下执行 Windows 系统命令并取回 stdout/stderr/退出码；
  - **系统信息探测**：OS 版本、主机名、当前用户、环境变量、磁盘、网络适配器等只读探测；
  - **Shell 交互**：默认程序打开 URL/文件/目录、剪贴板文本读写、系统通知。
- TS 侧建立**命令注册表**：每条系统命令显式登记（程序名、参数模板、用途、超时预算、
  输出编码），调用方只能按登记项调用，不接受自由字符串 shell。
- Rust 侧新增通用薄桥接命令（sysinfo / shell_open / clipboard / notify 类），
  `cli.rs` 白名单按用途逐项放行已评审的系统可执行文件stem——这是 envcheck 约定中
  「唯一必须动 Rust 的场景」，每次放行必须写明用途。
- 明确**非目标**：
  - 不提供任意 `cmd /c <字符串>` / PowerShell 自由命令通道（违反 AGENTS.md 白名单铁律，
    白名单是防 Bridge 沦为通用命令通道的最后一道闸）；cmd 内建命令（ver/dir 等）以
    原生等价实现覆盖，不走 shell 拼接；
  - 不含业务页面与业务语义（重试/退避/配额属于未来消费方），本变更只交付基础设施；
  - 不改变现有 welink/python 白名单项与相关编排逻辑。

## Capabilities

### New Capabilities

- `windows-command-exec`: 受控执行已登记的 Windows 系统命令。覆盖：命令注册表契约
  （登记什么才能跑什么）、执行结果结构（exitCode/stdout/stderr/截断/超时/耗时）、
  输出编码（base64 回传 + UTF-8→GBK 兜底）、白名单双重闸（TS 注册表 + Rust 白名单）、
  退出码非 0 不算通道故障、超时强杀与输出截断语义。
- `windows-system-info`: 只读系统信息探测。覆盖：系统概要（OS 版本/架构/主机名/当前
  用户）、环境变量读取（按名取值 + 脱敏约定）、磁盘与网络适配器枚举；结构化返回、
  永不 reject、硬超时、探测结果不含持久化。
- `windows-shell-integration`: 与 Windows Shell 的基础交互。覆盖：默认程序打开
  （URL/文件/目录，泛化现有 `open_storage_dir` 语义）、剪贴板文本读写、系统通知
  （fire-and-forget 语义、失败只上报不中断）、浏览器模式（web Bridge）的等价实现边界。

### Modified Capabilities

（项目尚无既有 spec，本变更全部为新能力。）

## Impact

- **Rust**（薄桥接，无业务规则）：`src-tauri/src/` 新增通用命令模块（预计 3~5 个命令，
  总命令数 16 → 约 20），`lib.rs` 注册；`cli.rs` 的 `ALLOWED_STEMS` 逐项扩展并写明用途；
  新模块复用 `cli.rs` 已有的 spawn_blocking / CREATE_NO_WINDOW / 输出截断模式。
- **Bridge**：`src/api/types.ts` 扩展接口，`tauri.ts` / `web.ts` 双侧实现，
  `index.ts` 平台自动选择；`src/types/index.ts` 增补结果类型。
- **TS**：新增 `src/infra/windows/**`（port / mock / adapter / registry / index 工厂 +
  同目录 spec 测试）；现有 `envcheck` 模块不动，但新增探测器可直接注册进 `createEnvChecks`。
- **测试门禁**：新模块同目录 `*.spec.ts`，收尾 `npm test` 全绿；不动覆盖率基线
  （本变更不触及 `orchestrator/**` / `infra/db/**`）。
- **文档**：AGENTS.md 的模拟替身标注约定补充本模块标签（`[MOCK-WIN]` 模拟实现 /
  `[WIN-ASSUME]` 对真实 Windows 行为的假设），与 `[MOCK-CLI]`/`[CLI-ASSUME]` 同款。
- **依赖**：不新增 npm 运行时依赖；Rust 侧优先用标准库（`std::env`/`std::process`），
  剪贴板/通知如需 crate 则选纯 Rust、可离线 vendoring 的方案（design.md 定夺）。
