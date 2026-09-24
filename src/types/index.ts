export type LogLevel = 'info' | 'warn' | 'error'

/** 存储布局：由宿主解析后回传，前端不自行拼接路径 */
export interface StorageLayout {
  root: string
  preferredRoot: string
  configFile: string
  tableFile: string
  logsDir: string
  /** 是否发生降级回退（如 D 盘不可用时落到用户目录） */
  fallback: boolean
  /** 降级原因，正常时为空串 */
  note: string
}

export interface AppInfo {
  name: string
  version: string
  tauriVersion: string
  platform: string
  arch: string
  configPath: string
  storage: StorageLayout
}

export interface AppSettings {
  theme: 'light' | 'dark'
  pageSize: number
  autoSave: boolean
  sidebarCollapsed: boolean
  defaultRoute: string
}

export type RowStatus = 'active' | 'inactive'

export interface TableRow {
  id: number
  name: string
  category: string
  status: RowStatus
  amount: number
  owner: string
  createdAt: string
}

export type TableRowDraft = Omit<TableRow, 'id' | 'createdAt'>
