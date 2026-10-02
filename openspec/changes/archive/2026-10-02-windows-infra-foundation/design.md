# Design

## Context

现状与约束（动机见 proposal.md 的 Why）：

- Rust 侧已有通用子进程通道 `cli_run`（`src-tauri/src/cli.rs`）：白名单 `ALLOWED_STEMS`
  （welink-cli / python / python3 / py）、参数数组不经 shell、`CREATE_NO_WINDOW`、
  单路输出 2 MB 截断、15s 超时强杀、输出 base64 回传。其注释明确：白名单是防 Bridge
  被当作通用命令通道的最后一道闸，**不接受「传什么跑什么」的放宽**。
- Bridge（`src/api/types.ts`）是前端与宿主的唯一边界，`tauri.ts` / `web.ts` 双实现
  契约一致，`index.ts` 按 `__TAURI_INTERNALS__` 自动选择；`src/` 禁止直接 import tauri。
- infra 层端口-适配器模式已在 envcheck 验证：port + mock + 适配器 + 注册表工厂，
  「永不 reject + 硬超时兜底」由工厂层统一施加。
- `src/utils/b64.ts` 已实现 base64 解码 + UTF-8 严格失败 → GBK 兜底。
- 打包约束：离线单文件 exe，Rust 依赖必须可 vendoring；`npm run pack` 有 PE 导入表硬校验。

## Goals / Non-Goals

**Goals:**

- 三个能力（command-exec / system-info / shell-integration）按既有模式完整落地：
  port + mock + 适配器 + 工厂 + 同目录测试，Bridge 双侧契约一致。
- 命令执行建立「TS 注册表 + Rust 白名单」双层闸门，命令登记数据化、安全属性代码化。
- mock 先行：浏览器模式可调试全部新能力；模拟替身与假设统一标注。

**Non-Goals:**

- 不提供 `cmd /c <自由字符串>` / PowerShell 自由命令通道（见 D1 的被拒方案）。
- 不做业务页面、不做业务语义（重试/退避/配额/留痕属消费方）。
- 不改动现有 welink/python 白名单项及 welink 编排逻辑。
- 不在本变更内把新探测注册进环境检测页（后续消费方自行接入 `createEnvChecks`）。

## Decisions

### D1. 命令执行 = 注册表 + 白名单双层闸，不走 `cmd /c` 自由字符串

- **选择**：TS 侧新增命令注册表（登记项：稳定 ID、程序名、参数模板、用途说明、
  超时预算），调用方只能按登记项发起执行；Rust 侧 `ALLOWED_STEMS` 对登记的程序
  **逐项**放行并注释用途。初始登记清单均为 System32 下的独立 EXE、只读诊断类：
  `systeminfo`、`ipconfig`、`tasklist`、`where`、`whoami`、`hostname`、`nslookup`、`ping`。
- **被拒方案一**：把 `cmd` / `powershell` 加入白名单、TS 拼 `/c` 参数 → 等价于
  任意命令通道，直接违反白名单铁律；且 TS 侧注册表闸对 stem 层白名单不可见，
  闸门只剩一层形同虚设。
- **被拒方案二**：配置文件驱动的白名单（config.json 可放宽）→ 安全面从代码评审
  转移到可被篡改的运行时配置；离线单文件场景也无热更新需求。
- cmd 内建命令（ver/hostname 等）不在 shell 内执行：由系统信息能力（D3）的 Rust
  原生实现覆盖；目录浏览由既有 fs 通道覆盖。**不需要 shell 拼接的场景就不开 shell。**

### D2. 白名单放行方式：静态代码清单，注释写明用途

沿用现状（`ALLOWED_STEMS` 常量 + 注释），不做数据驱动。理由：安全属性必须在
代码评审可见处；每次放行都是显式决策（同 envcheck port.ts 的既有约定）。

### D3. 系统信息走 Rust 原生读取，不走子进程

- 系统概要（OS 版本/架构/主机名/用户）：`std::env`（COMPUTERNAME/USERNAME 等）+
  注册表只读读取（`HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion` 的
  ProductName/DisplayVersion/CurrentBuildNumber）。
- 磁盘分区：`GetDiskFreeSpaceExW` 逐盘符探测；网络适配器：`GetAdaptersAddresses`
  （仅取首个 IPv4 单播地址）。
- **实现载体（实施期修订）**：全部经 `windows-sys`（已在依赖树内且源码已缓存），
  **不新增任何 crate**。设计初稿的 `winreg` 被替换：`Cargo.toml` 现有注释明确
  「不在内网缓存的 crate 会破坏打包不联网约束」，`winreg`/`arboard`/`notify-rust`
  均属此类；为守住硬约束改为 windows-sys 原生 API + 少量 unsafe（均为薄 FFI 调用，
  无业务规则，符合「Rust 无业务规则」边界）。
- **被拒方案**：解析 `systeminfo` 输出 → 输出随系统语言本地化、解析脆弱、且
  每次探测付出秒级子进程成本；原生读取毫秒级且结构化。
- 环境变量按名读取：`std::env::var_os` 直读（进程内，无 IPC 开销）。

### D4. Shell 交互：ShellExecuteW 统一「打开」；剪贴板/通知用 windows-sys 原生实现

- 打开 URL/文件/目录统一走 `ShellExecuteW`（"open" 动词，调用前线程内初始化 COM），
  泛化现有 `open_storage_dir` 语义；现有命令保留，不迁移调用方。
- 剪贴板：`OpenClipboard`/`SetClipboardData`/`GetClipboardData`（CF_UNICODETEXT，
  打开失败短重试）。
- 系统通知：`Shell_NotifyIconW` 托盘气球提示（NIF_INFO，message-only 属主窗口）。
  Win10+ 自动把气球提示转为 toast 通知；不依赖 AUMID/开始菜单快捷方式，对免安装
  单文件 exe 更可靠（WinRT toast 反而要求 AUMID 快捷方式，裸 exe 常静默失败）。
- **被拒方案**：Tauri 官方插件（clipboard-manager / notification / opener）→
  引入插件权限模型与 `@tauri-apps/plugin-*` JS 侧依赖，与「前端不直接依赖
  Tauri、交互一律走 Bridge」的既有约定摩擦更大；独立薄命令更贴合现状。
- **被拒方案**：`arboard`/`notify-rust` 第三方 crate → 不在内网 crate 缓存清单，
  破坏打包不联网硬约束（见 D3 修订理由）。

### D5. 结果语义分层：命令执行按 cli_run 先例，探测/交互「永不 reject」

- 命令执行沿用 `cliRun` 契约：退出码非 0 不算失败，仅通道故障 reject（Bridge 既有
  语义，见 types.ts 注释）。
- 系统信息探测与 Shell 交互方法**永不 reject**：返回统一结果对象
  （`{ ok: true, ...data } | { ok: false, reason, detail? }`），异常在适配器内折叠。
  理由：这两类是「探测/尽力而为」语义，调用方（诊断、通知）不应被迫写 try/catch；
  envcheck 已验证该模式可显著简化上层状态机。

### D6. infra/windows 模块结构（沿用 envcheck 形态）

```
src/infra/windows/
  port.ts        // 类型 + Port 接口 + 结果对象类型
  registry.ts    // 命令注册表（数据 + 登记项校验），[WIN-ASSUME] 逐条标注
  command-exec.ts // 命令执行适配器（base64 解码复用 utils/b64.ts）
  sysinfo.ts     // 系统信息适配器
  shell.ts       // Shell 交互适配器
  mock.ts        // [MOCK-WIN] 模拟实现（浏览器调试 + 测试替身）
  index.ts       // 工厂：平台切换 + 硬超时包装 + 永不 reject 施加
  *.spec.ts      // 与源码同目录
```

工厂强制施加横切属性（硬超时、异常折叠），实现在注册表入口而非指望每个实现者——
与 `createEnvChecks` 同款防御位置。**实施期修订**：模式语义为 `'bridge'`（默认，
双平台一致——桌面走 Rust 命令，浏览器走 web.ts 等价实现：系统信息 [MOCK-WIN]
模拟数据、Shell 交互浏览器 API、命令执行诚实拒绝）与 `'mock'`（测试替身，同样
套硬超时）。与 welink「浏览器强制 mock」的差别：本模块三能力浏览器**都能承载
等价语义**，无需强制；mock 分支也必须套硬超时（防挂死语义对替身同样成立）。

### D7. 模拟替身与假设标注

沿用 AGENTS.md 标签约定，新增模块专属标签：`[MOCK-WIN]`（模拟实现，对接后保留
为测试替身）、`[WIN-ASSUME]`（对真实 Windows 行为的假设：ShellExecuteW 动词语义、
注册表键路径、GBK 输出、toast 权限模型等）。AGENTS.md 的 grep 清单同步加入新标签。

### D8. 验证方式：spec 测试为主，桌面冒烟为辅

本变更无 UI 消费，验证靠：三模块同目录 `*.spec.ts`（mock 与真实适配器分离测试，
真实适配器在桌面 `tauri:dev` 冒烟）+ `npm run check` 全绿。Rust 侧新增命令按
`db.rs`/`cli.rs` 现状不含 Rust 单测（薄管道，逻辑在 TS 侧测）。

## Risks / Trade-offs

- [windows-sys feature 未在依赖树启用] → 实施时盘点 `Cargo.lock` 现有 feature，
  显式声明所需 feature（同 crate 加 feature 不算新增依赖，源码已缓存）。
- [unsafe FFI 调用笔误引发崩溃] → 全部走已缓存 windows-sys 0.61 源码核对过的
  签名；缓冲区固定长度 + NUL 截断填充；桌面冒烟逐项调用验证。
- [剪贴板写入在应用退出后可能丢失] → `OpenClipboard(null)` 属主语义的已知限制，
  `[WIN-ASSUME]` 标注；文本量小、生命周期内读回为主要场景，必要时后续引入
  隐藏属主窗口方案。
- [白名单扩展扩大攻击面] → 只登记只读诊断 EXE；每项 stem 注释写明用途；
  注册表内默认超时预算收紧（5s），需要更长的由登记项显式声明。
- [Rust 命令数增长，AGENTS.md「16 命令」口径过期] → 任务清单含 AGENTS.md
  同步更新（命令清单 + 标注约定 + 白名单说明）。
- [双实现契约漂移] → Bridge 新方法两侧实现 + `src/api/index.spec.ts` 既有契约
  测试模式扩展，新增方法逐一登记断言。

## Migration Plan

纯新增变更：无数据迁移、无既有行为变更。上线即生效，回滚 = 还原新增文件与
`lib.rs` 注册行。Bridge 接口新增方法与两侧实现在同一变更内完成，不存在中间态。

## Open Questions

无——影响 spec 与任务拆分的决策均已定；windows-sys feature 细节属实施期事项
（已列入 Risks 的降级路径）。
