import type { AppInfo } from '@/types'

export type Platform = 'tauri' | 'web'

/**
 * 前端与宿主环境之间的唯一边界：
 * 桌面端由 Rust 桥接命令实现，浏览器端由本地存储实现。
 */
export interface Bridge {
  readonly platform: Platform
  loadConfig(): Promise<string | null>
  saveConfig(content: string): Promise<void>
  appInfo(): Promise<AppInfo>
}
