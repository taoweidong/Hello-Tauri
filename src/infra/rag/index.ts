/**
 * RAG 工厂（设计 D-A）：上层只拿 `RagClient`，不 import 具体实现。
 *
 * 兜底规则对齐 agent 工厂：浏览器模式强制 mock（内网检索服务不可达，且 web
 * 文件/网络通道本就降级）；选 http 但 baseUrl 为空 → 回退 mock 并 warn。
 */
import { bridge, platform as runtime } from '@/api'
import type { WelinkRagSettings } from '@/types/welink'
import { logger } from '@/utils/logger'
import { createHttpRag, probeRagOnce, type RagHttpTransport } from './rag-http'
import { createMockRag, type MockRag } from './mock'
import { RagError, type RagClient } from './port'

let cached: RagClient | null = null
let cachedKey = ''

export interface RagClientOptions {
  settings: WelinkRagSettings
  /** mock 参数（测试注入延迟/故障） */
  mock?: Parameters<typeof createMockRag>[0]
}

/** 桌面模式把检索请求交给宿主通道（Rust `http_post_json`），浏览器强制 mock */
function hostTransport(): RagHttpTransport | undefined {
  return runtime === 'tauri'
    ? (url, headers, body, timeoutMs) => bridge.httpPostJson(url, headers, body, timeoutMs)
    : undefined
}

export function ragClient(options: RagClientOptions): RagClient {
  const { settings } = options
  const source = runtime === 'tauri' ? settings.ragSource : 'mock'
  const key = [
    source,
    settings.baseUrl,
    settings.endpoint,
    settings.apiKey,
    settings.timeoutMs,
    settings.topK,
    JSON.stringify(options.mock ?? {}),
  ].join('|')
  if (cached && cachedKey === key) return cached

  if (source === 'http' && settings.baseUrl.trim()) {
    // 密钥只进请求头不进日志：只打地址与路径
    logger.info(`RAG 端口：检索服务（${settings.baseUrl}${settings.endpoint} · topK=${settings.topK}）`)
    cached = createHttpRag({
      baseUrl: settings.baseUrl.trim(),
      endpoint: settings.endpoint,
      apiKey: settings.apiKey,
      topK: settings.topK,
      timeoutMs: settings.timeoutMs,
      transport: hostTransport(),
    })
  } else {
    if (source === 'http') {
      logger.warn('已选择检索服务但未配置 baseUrl，本次回退模拟数据源')
    }
    cached = createMockRag(options.mock)
  }
  cachedKey = key
  return cached
}

/** 测试用：清空缓存 */
export function resetRagClient() {
  cached = null
  cachedKey = ''
}

/**
 * 检索探测专用工厂（对齐 createAgentProbe）：按「用户配置指向的实现」发探测，
 * 共享 runtime 兜底判定但不进缓存、不挂 onCall。
 */
export function createRagProbe(settings: WelinkRagSettings): RagClient {
  const source = runtime === 'tauri' ? settings.ragSource : 'mock'
  if (source === 'http' && settings.baseUrl.trim()) {
    return createHttpRag({
      baseUrl: settings.baseUrl.trim(),
      endpoint: settings.endpoint,
      apiKey: settings.apiKey,
      topK: settings.topK,
      timeoutMs: settings.timeoutMs,
      transport: hostTransport(),
    })
  }
  return createMockRag()
}

/** 检索连通性测试（设置页按钮用） */
export function probeRag(settings: WelinkRagSettings): Promise<{ latencyMs: number; preview: string }> {
  // http 来源但地址未填：给可行动错误，而不是回退 mock 报「成功」误导配置者
  if (settings.ragSource === 'http' && !settings.baseUrl.trim()) {
    return Promise.reject(new RagError('已选择检索服务但未填写服务地址，请先补全 baseUrl', 'transport'))
  }
  if (runtime === 'tauri' && settings.ragSource === 'http' && settings.baseUrl.trim()) {
    return probeRagOnce({
      baseUrl: settings.baseUrl.trim(),
      endpoint: settings.endpoint,
      apiKey: settings.apiKey,
      topK: settings.topK,
      timeoutMs: Math.min(settings.timeoutMs, 15_000),
      transport: hostTransport(),
    })
  }
  // mock 来源的「测试检索」：直接给确定性演示结果
  return Promise.resolve({ latencyMs: 0, preview: '模拟检索：命中演示语料（来源 mock，桌面模式可连真实服务）' })
}

/** 当前是否为 mock（UI 来源徽标用） */
export function isMockRag(): boolean {
  const candidate = cached as Partial<MockRag> | null
  return typeof candidate?.failNext === 'function'
}

export type { RagClient, RagCallRecord, RagChunk, RagQuery, RagPort } from './port'
export { RagError } from './port'
