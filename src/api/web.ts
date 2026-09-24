import type { AppInfo, DbParam, DbRow, ExecResult, LogLevel, Migration, StorageLayout } from '@/types'
import type { Bridge } from './types'

const STORAGE_KEY = 'hello-tauri:config'
const TABLE_KEY = 'hello-tauri:table'

const WEB_LAYOUT: StorageLayout = {
  root: 'memory://hello-tauri',
  preferredRoot: 'D:\\TangYuan',
  configFile: 'memory://hello-tauri/config/config.json',
  tableFile: 'memory://hello-tauri/data/table.json',
  dbFile: 'memory://hello-tauri/data/app.db',
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
  // —— SQLite 通道：浏览器模式不做真 SQL（设计 Q3）。业务仓储在 web 模式走内存实现，
  //    不会调用这些方法；保留它们是为了让 Bridge 契约两侧方法集一致、调用即明确报错。 ——
  async dbExecute(_sql: string, _params: DbParam[] = []): Promise<ExecResult> {
    throw new Error('浏览器调试模式不支持通用 SQL，请在桌面模式使用')
  },
  async dbSelect(_sql: string, _params: DbParam[] = []): Promise<DbRow[]> {
    throw new Error('浏览器调试模式不支持通用 SQL，请在桌面模式使用')
  },
  async dbTransaction(_statements: { sql: string; params?: DbParam[] }[]): Promise<number[]> {
    throw new Error('浏览器调试模式不支持通用 SQL，请在桌面模式使用')
  },
  async dbMigrate(_migrations: Migration[]): Promise<number[]> {
    return []
  },
}