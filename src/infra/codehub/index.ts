/**
 * CodeHub 端口工厂（打桩 ↔ 真实 CLI 的**切换点**）。
 *
 * [MOCK-CLI] 本文件是 mock/cli 的切换点：真实 CLI 契约核实后无需改这里 ——
 * settings.source='cli' 且 cliPath 有效即自动走真实现。上层永远不 import 具体
 * 实现，因此「换真实接口」不需要动编排层任何一行（与 welink 工厂同构）。
 *
 * 两条兜底（都关乎「程序必须能跑起来」）：
 *  * 浏览器模式（无 Rust）**强制 mock**：`npm run dev` 全链路可调试（D5）；
 *  * 选 cli 但 cliPath 为空 → 回退 mock 并给出警告（而不是让每次同步都报错）。
 */
import { platform as runtime } from '@/api'
import type { CodeHubSettings } from '@/types/codehub'
import { logger } from '@/utils/logger'
import { createCliCodeHubPort } from './codehub-cli'
import { createMockCodeHubPort, type MockCodeHubOptions, type MockCodeHubPort } from './mock'
import type { CodeHubPort, CodeHubVerifyResult } from './port'

let cached: CodeHubPort | null = null
let cachedKey = ''

/** 当前端口是否为 mock（检视页来源徽标 & 故障注入入口的显示依据） */
export function isMockCodeHub(): boolean {
  return mockHandle() !== null
}

interface PortOptions {
  settings: CodeHubSettings
  /** 通用 mock 参数（测试注入延迟/故障） */
  mock?: MockCodeHubOptions
}

/**
 * 取（或重建）端口实例。缓存键包含影响实现选择的字段：配置一改（比如从 mock 切
 * 到 cli、token 换值）必须换实例，否则用户改完设置发现「没生效」。
 * 键里允许出现 token（仅存内存，且 settings 对象本就持有它）—— 换 token 必须重建。
 */
export function codeHubPort(options: PortOptions): CodeHubPort {
  const { settings } = options
  const source = runtime === 'tauri' ? settings.source : 'mock'
  const key = [source, settings.cliPath, settings.token, JSON.stringify(options.mock ?? {})].join('|')

  if (cached && cachedKey === key) return cached

  if (source === 'cli' && settings.cliPath.trim()) {
    logger.info(`CodeHub 端口：真实 CLI（${settings.cliPath}）`)
    cached = createCliCodeHubPort({
      cliPath: settings.cliPath.trim(),
      token: settings.token,
      timeoutMs: 12_000,
    })
  } else {
    if (source === 'cli') {
      logger.warn('已选择真实 CLI 但未配置路径，本次回退 mock 数据源')
    } else if (runtime !== 'tauri') {
      logger.info('浏览器调试模式：CodeHub 使用 mock 数据源')
    }
    cached = createMockCodeHubPort(options.mock)
  }
  cachedKey = key
  return cached
}

/** 测试用：清空端口缓存 */
export function resetCodeHubPort() {
  cached = null
  cachedKey = ''
}

/** 取当前 mock 实例（UI/编排层需要故障注入时用；非 mock 返回 null） */
export function mockHandle(): MockCodeHubPort | null {
  if (!cached) return null
  const candidate = cached as Partial<MockCodeHubPort>
  return typeof candidate.injectTransportFailure === 'function' && typeof candidate.injectParseFailure === 'function'
    ? (cached as MockCodeHubPort)
    : null
}

export type { CodeHubPort, CodeHubVerifyResult }
