/**
 * Windows 基础设施工厂（design D6）。
 *
 * 与 `createEnvChecks` 同款防御位置：横切属性（硬超时、异常折叠）统一施加在
 * 工厂层，而不是指望每个实现者都记得。模式语义（实施期修订，与 welink 强制
 * mock 的差别见下）：
 *  * `'bridge'`（默认，双平台一致）：经 Bridge 的真实实现 —— 桌面走 Rust 命令，
 *    浏览器走 web.ts 的等价实现（系统信息为 [MOCK-WIN] 模拟数据、Shell 交互为
 *    浏览器 API、命令执行诚实拒绝）。浏览器**能够**承载这三个能力的等价语义，
 *    因此不像 welink 那样强制 mock；
 *  * `'mock'`：[MOCK-WIN] 测试替身，测试与离线演示用，不触碰 Bridge。
 */
import { bridge } from '@/api'
import { logger } from '@/utils/logger'
import { createCommandRunner } from './command-exec'
import { createMockWindowsInfra, type MockWindowsInfraOptions } from './mock'
import { HARD_TIMEOUT_MS, type CommandExecOutcome, type WindowsInfraPort } from './port'
import { createShellInteractions } from './shell'
import { createSysinfoProbes } from './sysinfo'

export interface WindowsInfraOptions {
  /** 'bridge' = 经 Bridge 真实实现；'mock' = [MOCK-WIN] 测试替身。缺省 'bridge' */
  mode?: 'bridge' | 'mock'
  /** 工厂层硬超时（毫秒），测试可注入小值 */
  hardTimeoutMs?: number
  /** mock 参数透传（mode='mock' 时生效） */
  mock?: MockWindowsInfraOptions
}

/** 硬超时的确定性命令结果（exitCode 空 + timedOut，与 cli_run 超时语义一致） */
function timeoutExecOutcome(durationMs: number): CommandExecOutcome {
  return {
    exitCode: null,
    stdout: '',
    stderr: '',
    stdoutTruncated: false,
    stderrTruncated: false,
    timedOut: true,
    durationMs,
  }
}

/** 硬超时包装（命令执行）：rejection 正常传播（通道故障契约），只有挂死才超时 */
async function strictTimeout<T>(task: () => Promise<T>, timeoutMs: number, onTimeout: () => T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await new Promise<T>((resolve, reject) => {
      timer = setTimeout(() => resolve(onTimeout()), timeoutMs)
      task().then(resolve, reject)
    })
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/**
 * 硬超时 + 异常折叠包装（探测/交互）：`failure` 由调用方按结果形状构造；
 * 底层 rejection（正常路径已被适配器 backstop 折叠，这里只兜工厂自身之前的违约）
 * 也折叠为失败结果 —— 本工厂产出的端口**永不 reject**（runCommand 除外）。
 */
async function foldedTimeout<T>(
  task: () => Promise<T>,
  timeoutMs: number,
  failure: (detail: string) => T,
): Promise<T> {
  const started = Date.now()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await new Promise<T>((resolve) => {
      timer = setTimeout(() => resolve(failure(`硬超时（超过 ${Date.now() - started}ms 未返回）`)), timeoutMs)
      task().then(resolve, (error: unknown) =>
        resolve(failure(error instanceof Error ? error.message : String(error))),
      )
    })
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/** 给原始端口统一施加硬超时与折叠 */
function withHardTimeouts(raw: WindowsInfraPort, budget: number): WindowsInfraPort {
  return {
    runCommand: (commandId, extraArgs) =>
      strictTimeout(() => raw.runCommand(commandId, extraArgs), budget, () =>
        timeoutExecOutcome(budget),
      ),
    probeOverview: () =>
      foldedTimeout(() => raw.probeOverview(), budget, (detail) => ({ ok: false, reason: '系统概要探测失败', detail })),
    probeEnvVar: (name) =>
      foldedTimeout(() => raw.probeEnvVar(name), budget, (detail) => ({ ok: false, reason: '环境变量读取失败', detail })),
    probeDisks: () =>
      foldedTimeout(() => raw.probeDisks(), budget, (detail) => ({ ok: false, reason: '磁盘探测失败', detail })),
    probeAdapters: () =>
      foldedTimeout(() => raw.probeAdapters(), budget, (detail) => ({ ok: false, reason: '网卡探测失败', detail })),
    openWithDefault: (target) =>
      foldedTimeout(() => raw.openWithDefault(target), budget, (detail) => ({ ok: false, reason: '默认程序打开失败', detail })),
    readClipboard: () =>
      foldedTimeout(() => raw.readClipboard(), budget, (detail) => ({ ok: false, reason: '剪贴板读取失败', detail })),
    writeClipboard: (text) =>
      foldedTimeout(() => raw.writeClipboard(text), budget, (detail) => ({ ok: false, reason: '剪贴板写入失败', detail })),
    notify: (title, body) =>
      foldedTimeout(() => raw.notify(title, body), budget, (detail) => ({ ok: false, reason: '系统通知发送失败', detail })),
  }
}

/** 组装当前环境的 Windows 基础设施端口（每次调用独立；配置变化由调用方重建） */
export function createWindowsInfra(options: WindowsInfraOptions = {}): WindowsInfraPort {
  const mode = options.mode ?? 'bridge'
  const budget = options.hardTimeoutMs ?? HARD_TIMEOUT_MS

  if (mode === 'mock') {
    logger.info('Windows 基础设施：[MOCK-WIN] 模拟数据源')
    return withHardTimeouts(createMockWindowsInfra(options.mock), budget)
  }

  const raw: WindowsInfraPort = {
    runCommand: createCommandRunner(),
    ...createSysinfoProbes(bridge),
    ...createShellInteractions(bridge),
  }
  return withHardTimeouts(raw, budget)
}
