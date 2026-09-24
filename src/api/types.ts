import type { AppInfo, LogLevel, StorageLayout } from '@/types'

export type Platform = 'tauri' | 'web'

/**
 * 前端与宿主环境之间的唯一边界。
 *
 * 桌面端由 Rust 命令实现，浏览器端为内存模拟实现（仅用于开发调试）。
 * 新增任何需要宿主能力的功能，先扩这里，再同时实现两侧 —— 两个实现必须契约一致。
 */
export interface Bridge {
  readonly platform: Platform
  loadConfig(): Promise<string | null>
  saveConfig(content: string): Promise<void>
  readTable(): Promise<string | null>
  writeTable(content: string): Promise<void>
  /** 追加一行日志，返回写入的日志文件绝对路径 */
  appendLog(level: LogLevel, message: string): Promise<string>
  storageInfo(): Promise<StorageLayout>
  /** 在系统文件管理器中打开存储目录 */
  openStorageDir(): Promise<void>
  appInfo(): Promise<AppInfo>
}