/**
 * Agent 工厂（设计 §3.3 的切换点与兜底策略）。
 *
 * 与 welink 工厂同构：上层只拿 `AgentClient`，不 import 具体实现。
 *
 * 兜底规则（O8/O14 的「把静默拒绝变成显式指引」）：
 *  * 浏览器模式强制 mock（无内网环境，fetch 必然失败）；
 *  * 选 http 但 baseUrl 为空 → 回退 mock **并 warn** —— UI 会把这句警告显示成
 *    「已回退模拟数据源」提示，避免用户以为「改了配置没生效」。
 */
import { platform as runtime } from '@/api'
import type { WelinkAgentSettings } from '@/types/welink'
import { logger } from '@/utils/logger'
import { createHttpAgent } from './agent-http'
import { createMockAgent, type MockAgent } from './mock'
import type { AgentClient } from './port'

let cached: AgentClient | null = null
let cachedKey = ''

export interface AgentClientOptions {
  settings: WelinkAgentSettings
  /** mock 参数（测试注入延迟/故障/模板） */
  mock?: Parameters<typeof createMockAgent>[0]
}

export function agentClient(options: AgentClientOptions): AgentClient {
  const { settings } = options
  const source = runtime === 'tauri' ? settings.agentSource : 'mock'
  const key = [
    source,
    settings.baseUrl,
    settings.endpoint,
    settings.timeoutMs,
    JSON.stringify(options.mock ?? {}),
  ].join('|')
  if (cached && cachedKey === key) return cached

  if (source === 'http' && settings.baseUrl.trim()) {
    logger.info(`Agent 端口：内网 HTTP（${settings.baseUrl}${settings.endpoint}）`)
    cached = createHttpAgent({
      baseUrl: settings.baseUrl.trim(),
      endpoint: settings.endpoint,
      timeoutMs: settings.timeoutMs,
    })
  } else {
    if (source === 'http') {
      logger.warn('已选择内网 Agent 但未配置 baseUrl，本次回退模拟数据源')
    }
    cached = createMockAgent(options.mock)
  }
  cachedKey = key
  return cached
}

/** 测试用：清空缓存 */
export function resetAgentClient() {
  cached = null
  cachedKey = ''
}

/**
 * 连通性探测专用工厂（评审 A-1）。
 *
 * SettingsCard 要按「用户配置指向的实现」发探测请求：直接 new agent-http 会
 * 绕过环境兜底——浏览器模式下运行链路被强制 mock，探测却真实外发 fetch 并报
 * 「Agent 连通正常」，两处对「当前实现」的判定不一致（给假信心）；走
 * agentClient() 又会命中运行期缓存。这里共享同一份 runtime 兜底判定，
 * 但**不进缓存、不挂 onCall**——探测请求不污染 R4 留痕语料。
 */
export function createAgentProbe(settings: WelinkAgentSettings): AgentClient {
  const source = runtime === 'tauri' ? settings.agentSource : 'mock'
  if (source === 'http' && settings.baseUrl.trim()) {
    return createHttpAgent({
      baseUrl: settings.baseUrl.trim(),
      endpoint: settings.endpoint,
      timeoutMs: settings.timeoutMs,
    })
  }
  return createMockAgent()
}

/** 当前是否为 mock（UI 来源徽标用） */
export function isMockAgent(): boolean {
  const candidate = cached as Partial<MockAgent> | null
  return typeof candidate?.failNext === 'function'
}

export type { AgentClient, AgentCallRecord } from './port'
export { AgentError } from './port'
