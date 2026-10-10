/**
 * 更新客户端工厂（设计 U-L 的切换点）。上层只拿 `UpdateClient`，不 import 具体实现。
 *
 * 兜底规则与 agent/welink 工厂同构：浏览器模式强制 mock（无宿主进程与文件语义，
 * 真实通道必然失败）；桌面模式走 http 实现（宿主 GET/下载/验签/自替换通道）。
 */
import { bridge, platform as runtime } from '@/api'
import { logger } from '@/utils/logger'
import { createHttpUpdateClient, type UpdateClient } from './client'
import { createMockUpdateClient } from './mock'

let cached: UpdateClient | null = null

export function updateClient(): UpdateClient {
  if (!cached) {
    if (runtime === 'tauri') {
      logger.info('更新端口：宿主通道（http GET / 流式下载 / minisign 验签 / 自替换）')
      cached = createHttpUpdateClient(bridge)
    } else {
      logger.info('更新端口：[MOCK-UPDATE] 浏览器模拟（假清单 + 假进度）')
      cached = createMockUpdateClient({ currentVersion: __APP_VERSION__ })
    }
  }
  return cached
}

export {
  assertSameEndpoint,
  parseManifest,
  pickPlatform,
  UpdateError,
  type DownloadOptions,
  type ManifestPlatform,
  type ManifestSource,
  type UpdateClient,
  type UpdateErrorStep,
  type UpdateManifest,
} from './client'
export { UPDATE_PUBLIC_KEY } from './key'
