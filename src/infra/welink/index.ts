/**
 * WeLink 端口工厂（设计 §3.3 的切换点）。
 *
 * 唯一入口 `welinkClient()`：按配置返回 mock 或 cli 实现。上层永远不 import 具体实现，
 * 因此「换真实接口」不需要动编排层任何一行。
 *
 * 两条兜底（都关乎「程序必须能跑起来」）：
 *  * 浏览器模式（无 Rust）**强制 mock**：设计 §3.3/D5 要求 `npm run dev` 全链路可调试；
 *  * 选 cli 但 cliPath 为空 → 回退 mock 并给出警告（而不是让每次轮询都报错）。
 */
import { platform as runtime } from '@/api'
import type { WelinkSettings } from '@/types/welink'
import { logger } from '@/utils/logger'
import { createMockWelinkPort, type MockWelinkOptions, type MockWelinkPort } from './mock'
import type { WelinkPort } from './port'
import { createCliWelinkPort } from './welink-cli'

let cached: WelinkPort | null = null
let cachedKey = ''

/** 当前端口是否为 mock（UI 顶部来源徽标 & 演示剧本按钮的显示依据） */
export function isMockWelink(): boolean {
  return mockHandle() !== null
}

interface ClientOptions {
  settings: WelinkSettings
  /** 演示剧本模式（O13）：mock 端口按剧本回放而非常规消息池 */
  scripted?: boolean
  /** 通用 mock 参数（测试注入延迟/故障） */
  mock?: MockWelinkOptions
}

/**
 * 取（或重建）端口实例。
 *
 * 缓存键包含影响实现选择的字段：配置一改（比如从 mock 切到 cli）必须换实例，
 * 否则用户改完设置发现「没生效」—— 这正是 O14 想让 UI 标注「生效时机」的那类坑。
 */
export function welinkClient(options: ClientOptions): WelinkPort {
  const { settings } = options
  const source = runtime === 'tauri' ? settings.welinkSource : 'mock'
  const key = [
    source,
    settings.cliPath,
    settings.myUserId,
    settings.agent.timeoutMs,
    options.scripted ? 'scripted' : 'plain',
    JSON.stringify(options.mock ?? {}),
  ].join('|')

  if (cached && cachedKey === key) return cached

  if (source === 'cli' && settings.cliPath.trim()) {
    logger.info(`WeLink 端口：真实 CLI（${settings.cliPath}）`)
    cached = createCliWelinkPort({
      cliPath: settings.cliPath.trim(),
      myUserId: settings.myUserId,
      timeoutMs: Math.min(settings.agent.timeoutMs, 12_000),
    })
  } else {
    if (source === 'cli') {
      logger.warn('已选择真实 CLI 但未配置路径，本次回退 mock 数据源')
    } else if (runtime !== 'tauri') {
      logger.info('浏览器调试模式：WeLink 使用 mock 数据源')
    }
    const mock = createMockWelinkPort(options.mock)
    if (options.scripted) mock.playScript()
    cached = mock
  }
  cachedKey = key
  return cached
}

/** 测试用：清空端口缓存 */
export function resetWelinkClient() {
  cached = null
  cachedKey = ''
}

/** 取当前 mock 实例（UI/编排层需要 playScript/reset 时用；非 mock 返回 null） */
export function mockHandle(): MockWelinkPort | null {
  if (!cached) return null
  const candidate = cached as Partial<MockWelinkPort>
  return typeof candidate.playScript === 'function' && typeof candidate.reset === 'function'
    ? (cached as MockWelinkPort)
    : null
}

export type { WelinkPort }