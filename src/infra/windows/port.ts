/**
 * Windows 基础设施端口 —— 与 Windows 宿主交互的外部世界形状（design D6）。
 *
 * 设计要点（为什么不是复用 WelinkPort / EnvCheckItem）：
 *  * 命令执行沿用 cliRun 通道契约（退出码非 0 不算失败、仅通道故障 reject），
 *    但入口收窄到命令注册表（registry.ts）：调用方只能按登记 ID 发起；
 *  * 探测与 Shell 交互是**尽力而为**语义：结果对象承载成败（`ProbeResult` /
 *    `BasicOutcome`），实现层必须永不 reject —— 与 Bridge 层同契约，本模块
 *    再兜一层底（适配器 backstop + 工厂硬超时），上层状态机没有异常分支；
 *  * 端口不认识任何业务语义（重试/退避/留痕归消费方）。
 */
import type { BasicOutcome, ProbeResult, SysAdapter, SysDisk, SysOverview } from '@/types'

export type { BasicOutcome, ProbeResult, SysAdapter, SysDisk, SysOverview }

/** 系统命令执行结果（输出已按 UTF-8→GBK 兜底解码为文本） */
export interface CommandExecOutcome {
  /** 退出码；进程被超时强杀时为 null */
  exitCode: number | null
  stdout: string
  stderr: string
  stdoutTruncated: boolean
  stderrTruncated: boolean
  timedOut: boolean
  durationMs: number
}

/** Windows 基础设施端口：三个能力域的统一形状 */
export interface WindowsInfraPort {
  /** 按注册表 ID 执行已登记的系统命令；未登记 ID / 参数超限以通道故障 reject */
  runCommand(commandId: string, extraArgs?: string[]): Promise<CommandExecOutcome>
  /** 系统概要探测（只读） */
  probeOverview(): Promise<ProbeResult<SysOverview>>
  /** 按名读进程环境变量；不存在 → data:null（不是失败） */
  probeEnvVar(name: string): Promise<ProbeResult<string | null>>
  /** 磁盘分区枚举（只读） */
  probeDisks(): Promise<ProbeResult<SysDisk[]>>
  /** 网络适配器枚举（只读） */
  probeAdapters(): Promise<ProbeResult<SysAdapter[]>>
  /** 用系统默认程序打开 http/https URL 或本地文件/目录 */
  openWithDefault(target: string): Promise<BasicOutcome>
  /** 读剪贴板纯文本；无文本内容 → data:null（不是失败） */
  readClipboard(): Promise<ProbeResult<string | null>>
  /** 写剪贴板纯文本（覆盖） */
  writeClipboard(text: string): Promise<BasicOutcome>
  /** 发系统通知；能力不可用 → 未送达结果（不是异常） */
  notify(title: string, body: string): Promise<BasicOutcome>
}

/**
 * 工厂层硬超时（与 envcheck 的 HARD_TIMEOUT_MS 同款防御位置）：注册表最大
 * 超时预算 10s（system-info），加 generous 余量兜「bridge 挂死」等真异常。
 * 必须大于所有登记命令的 timeoutMs 之和的最大值对应项 —— 见 registry.ts。
 */
export const HARD_TIMEOUT_MS = 20_000
