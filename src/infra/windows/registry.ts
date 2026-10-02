/**
 * Windows 系统命令注册表（design D1：TS 注册表闸 + Rust 白名单闸 = 双层闸）。
 *
 * 铁律：
 *  * 只有本清单登记过的命令才能执行，调用方只能按稳定 ID 引用 + 追加限额内的
 *    字面参数 —— 不存在「传什么跑什么」的自由 shell 路径；
 *  * 每个登记项的 `program` 必须同步放行到 Rust 白名单
 *    （`src-tauri/src/cli.rs` 的 `ALLOWED_STEMS`），放行时写明用途；
 *  * 新增登记项 = 一次显式的安全评审：程序必须是只读诊断类 System32 EXE，
 *    固定参数写死在登记项里，追加参数按字面传递、不经 shell。
 *
 * [WIN-ASSUME] 参数语法按 Windows 原生行为登记：
 *  * `ping` 用 `-n <次数>`（Windows 语法；Linux 是 `-c`，不可混用）；
 *  * `where` / `nslookup` 至少需要一个定位目标（由 extraArgs 下限保证为 1）；
 *  * 全部程序均为 System32 下的独立 EXE，无 cmd 内建命令（内建一律走
 *    Rust 原生等价实现，见 design D1/D3）。
 */

/** 一个登记项（评审的最小单元） */
export interface RegisteredCommand {
  /** 稳定 ID（调用方引用；不得复用/改名，改名=破坏性变更） */
  id: string
  /** 程序名（不含路径；主干名必须在 Rust 白名单内） */
  program: string
  /** 固定参数（评审登记的一部分，调用方不能增删） */
  args: string[]
  /** 允许调用方追加的字面参数个数（0 = 不允许追加） */
  extraArgs: number
  /** 用途说明（中文，评审可见） */
  purpose: string
  /** 超时预算（毫秒）：默认收紧 5s，慢命令必须在此显式放宽 */
  timeoutMs: number
}

/** 默认超时预算：诊断命令必须快进快出 */
export const DEFAULT_COMMAND_TIMEOUT_MS = 5_000

/** 登记清单（全部只读诊断；顺序即展示顺序） */
export const REGISTERED_COMMANDS: readonly RegisteredCommand[] = [
  {
    id: 'system-info',
    program: 'systeminfo',
    args: [],
    extraArgs: 0,
    purpose: '系统概要文本清单（OS/补丁/内存/网卡），环境诊断',
    // [WIN-ASSUME] systeminfo 冷启动输出需数秒，放宽到 10s
    timeoutMs: 10_000,
  },
  {
    id: 'ipconfig-all',
    program: 'ipconfig',
    args: ['/all'],
    extraArgs: 0,
    purpose: '完整网络配置（含 DNS/网关/MAC），环境诊断',
    timeoutMs: DEFAULT_COMMAND_TIMEOUT_MS,
  },
  {
    id: 'task-list',
    program: 'tasklist',
    args: [],
    extraArgs: 0,
    purpose: '运行中进程清单，环境诊断',
    timeoutMs: DEFAULT_COMMAND_TIMEOUT_MS,
  },
  {
    id: 'where-exe',
    program: 'where',
    args: [],
    extraArgs: 1,
    // [WIN-ASSUME] where 需要 1 个定位模式参数
    purpose: '按名定位可执行文件路径（1 个必填定位目标），环境诊断',
    timeoutMs: DEFAULT_COMMAND_TIMEOUT_MS,
  },
  {
    id: 'whoami',
    program: 'whoami',
    args: [],
    extraArgs: 0,
    purpose: '当前用户域账号，环境诊断',
    timeoutMs: DEFAULT_COMMAND_TIMEOUT_MS,
  },
  {
    id: 'hostname',
    program: 'hostname',
    args: [],
    extraArgs: 0,
    purpose: '主机名，环境诊断',
    timeoutMs: DEFAULT_COMMAND_TIMEOUT_MS,
  },
  {
    id: 'nslookup',
    program: 'nslookup',
    args: [],
    extraArgs: 1,
    // [WIN-ASSUME] nslookup 需要 1 个目标域名
    purpose: 'DNS 解析探测（1 个必填域名），网络诊断',
    timeoutMs: DEFAULT_COMMAND_TIMEOUT_MS,
  },
  {
    id: 'ping-host',
    program: 'ping',
    args: ['-n', '4'],
    extraArgs: 1,
    // [WIN-ASSUME] Windows ping 计数参数是 -n（4 次回显约 3s）
    purpose: '连通性探测（1 个必填主机，固定 4 次回显），网络诊断',
    timeoutMs: 8_000,
  },
]

/** 按稳定 ID 取登记项 */
export function getRegisteredCommand(id: string): RegisteredCommand | undefined {
  return REGISTERED_COMMANDS.find((entry) => entry.id === id)
}

/** 全部登记项（供诊断界面展示；调用方仍只能经 runCommand 执行） */
export function listRegisteredCommands(): readonly RegisteredCommand[] {
  return REGISTERED_COMMANDS
}
