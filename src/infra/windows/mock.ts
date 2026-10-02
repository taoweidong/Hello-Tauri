/**
 * [MOCK-WIN] Windows 基础设施模拟实现。
 *
 * 用途（与 [MOCK-CLI] 同款约定）：测试替身 + 浏览器/离线调试数据源。对接真实
 * 宿主后**保留**本文件；本实现不经过 Bridge，模拟的命令执行不会触碰白名单。
 *
 * 可注入项：统一延迟（测硬超时）、按域失败（测折叠路径）、每条命令的 canned
 * 输出（测解析与 GBK 场景）。所有调用记录进 `calls`，供测试断言。
 */
import type { CommandExecOutcome, WindowsInfraPort } from './port'
import type { BasicOutcome, ProbeResult, SysAdapter, SysDisk, SysOverview } from '@/types'
import { getRegisteredCommand } from './registry'

export interface MockWindowsInfraOptions {
  /** 每个调用的模拟延迟（毫秒），默认 0 */
  delayMs?: number
  /** 探测类调用统一失败（ok:false） */
  failProbes?: boolean
  /** Shell 交互类调用统一失败（ok:false） */
  failShell?: boolean
  /** 命令执行统一抛通道故障（测 reject 路径） */
  failCommands?: boolean
  /** 按 ID 覆盖 canned 命令输出 */
  commandOutputs?: Record<string, CommandExecOutcome>
  /** 初始剪贴板内容 */
  clipboard?: string | null
}

/** 模拟系统的固定数据（[MOCK-WIN] 标注写入展示字段） */
const MOCK_OVERVIEW: SysOverview = {
  osName: '[MOCK-WIN] Windows 11 专业版',
  osVersion: '[MOCK-WIN] 23H2 build 22631',
  arch: 'x86_64',
  hostname: 'mock-hostname',
  username: 'mock-user',
  dataRoot: 'memory://hello-tauri',
}

const MOCK_DISKS: SysDisk[] = [
  { letter: 'C', totalBytes: 512_110_190_592, freeBytes: 128_849_018_880 },
  { letter: 'D', totalBytes: 1_000_203_481_088, freeBytes: 644_245_094_400 },
]

const MOCK_ADAPTERS: SysAdapter[] = [
  { name: '[MOCK-WIN] 以太网', enabled: true, ipv4: '192.168.1.100' },
  { name: '[MOCK-WIN] WLAN', enabled: false, ipv4: null },
]

function cannedOutcome(id: string): CommandExecOutcome {
  return {
    exitCode: 0,
    stdout: `[MOCK-WIN] ${getRegisteredCommand(id)?.program ?? id} 的模拟输出`,
    stderr: '',
    stdoutTruncated: false,
    stderrTruncated: false,
    timedOut: false,
    durationMs: 42,
  }
}

export interface MockWindowsInfraState {
  /** 剪贴板当前内容（读写共用） */
  clipboard: string | null
  /** 已执行命令（id + 追加参数） */
  executedCommands: { commandId: string; extraArgs: string[] }[]
  /** 已尝试打开的目标 */
  openedTargets: string[]
  /** 已尝试发出的通知 */
  notifications: { title: string; body: string }[]
  /** 已读取过的环境变量名 */
  envVarNames: string[]
}

export function createMockWindowsInfra(options: MockWindowsInfraOptions = {}): WindowsInfraPort & { state: MockWindowsInfraState } {
  const delay = async () => {
    if (options.delayMs && options.delayMs > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, options.delayMs))
    }
  }

  const state: MockWindowsInfraState = {
    clipboard: options.clipboard ?? null,
    executedCommands: [],
    openedTargets: [],
    notifications: [],
    envVarNames: [],
  }

  const port: WindowsInfraPort = {
    async runCommand(commandId, extraArgs = []) {
      state.executedCommands.push({ commandId, extraArgs })
      if (options.failCommands) {
        throw new Error(`[MOCK-WIN] 注入的命令通道故障：${commandId}`)
      }
      await delay()
      if (options.commandOutputs?.[commandId]) {
        return options.commandOutputs[commandId]
      }
      return cannedOutcome(commandId)
    },
    async probeOverview() {
      await delay()
      if (options.failProbes) return { ok: false, reason: '[MOCK-WIN] 注入的探测失败' }
      return { ok: true, data: { ...MOCK_OVERVIEW } }
    },
    async probeEnvVar(name) {
      state.envVarNames.push(name)
      await delay()
      if (options.failProbes) return { ok: false, reason: '[MOCK-WIN] 注入的探测失败' }
      // 模拟环境只有这一个「存在」的变量，其余一律不存在（data:null）
      return name === 'PATH' ? { ok: true, data: '[MOCK-WIN] C:\\mock\\bin' } : { ok: true, data: null }
    },
    async probeDisks() {
      await delay()
      if (options.failProbes) return { ok: false, reason: '[MOCK-WIN] 注入的探测失败' }
      return { ok: true, data: MOCK_DISKS.map((disk) => ({ ...disk })) }
    },
    async probeAdapters() {
      await delay()
      if (options.failProbes) return { ok: false, reason: '[MOCK-WIN] 注入的探测失败' }
      return { ok: true, data: MOCK_ADAPTERS.map((adapter) => ({ ...adapter })) }
    },
    async openWithDefault(target) {
      state.openedTargets.push(target)
      await delay()
      if (options.failShell) return { ok: false, reason: '[MOCK-WIN] 注入的 Shell 失败' }
      return { ok: true }
    },
    async readClipboard() {
      await delay()
      if (options.failShell) return { ok: false, reason: '[MOCK-WIN] 注入的 Shell 失败' }
      return { ok: true, data: state.clipboard }
    },
    async writeClipboard(text) {
      await delay()
      if (options.failShell) return { ok: false, reason: '[MOCK-WIN] 注入的 Shell 失败' }
      state.clipboard = text
      return { ok: true }
    },
    async notify(title, body) {
      state.notifications.push({ title, body })
      await delay()
      if (options.failShell) return { ok: false, reason: '[MOCK-WIN] 注入的通知失败' } satisfies BasicOutcome
      return { ok: true }
    },
  }

  return { ...port, state }
}

/** 导出状态类型与失败结果便捷断言用的类型收窄（测试用） */
export type { BasicOutcome, ProbeResult }
