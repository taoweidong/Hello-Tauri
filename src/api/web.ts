import type { AppInfo, LogLevel, StorageLayout } from '@/types'
import type { Bridge } from './types'

const STORAGE_KEY = 'hello-tauri:config'
const TABLE_KEY = 'hello-tauri:table'

const WEB_LAYOUT: StorageLayout = {
  root: 'memory://hello-tauri',
  preferredRoot: 'D:\\TangYuan',
  configFile: 'memory://hello-tauri/config/config.json',
  tableFile: 'memory://hello-tauri/data/table.json',
  logsDir: 'memory://hello-tauri/logs',
  fallback: true,
  note: '浏览器调试模式：数据保存在内存中，刷新即重置；桌面模式下写入 D:\\TangYuan',
}

/** 浏览器调试用的内存日志，刷新即清空 —— 不触碰任何持久化介质 */
const logs: string[] = []

function stamp() {
  const now = new Date()
  const pad = (value: number, width = 2) => String(value).padStart(width, '0')
  return {
    date: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`,
    clock: `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}.${pad(now.getMilliseconds(), 3)}`,
  }
}

export const webBridge: Bridge = {
  platform: 'web',
  async loadConfig() {
    return localStorage.getItem(STORAGE_KEY)
  },
  async saveConfig(content) {
    localStorage.setItem(STORAGE_KEY, content)
  },
  async readTable() {
    return localStorage.getItem(TABLE_KEY)
  },
  async writeTable(content) {
    localStorage.setItem(TABLE_KEY, content)
  },
  async appendLog(level: LogLevel, message: string) {
    const { date, clock } = stamp()
    logs.push(`${clock} [${level.toUpperCase()}] ${message}`)
    return `memory://hello-tauri/logs/app-${date}.log`
  },
  async storageInfo() {
    return { ...WEB_LAYOUT }
  },
  async openStorageDir() {
    throw new Error('浏览器调试模式不支持打开本地目录')
  },
  async appInfo() {
    return {
      name: 'Hello-Tauri',
      version: '0.1.0',
      tauriVersion: '-',
      platform: 'web',
      arch: '-',
      configPath: WEB_LAYOUT.configFile,
      storage: { ...WEB_LAYOUT },
    } satisfies AppInfo
  },
}