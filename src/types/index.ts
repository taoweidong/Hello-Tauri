export type LogLevel = 'info' | 'warn' | 'error'

/** 存储布局：由宿主解析后回传，前端不自行拼接路径 */
export interface StorageLayout {
  root: string
  preferredRoot: string
  configFile: string
  tableFile: string
  /** SQLite 数据库文件 {root}/data/app.db */
  dbFile: string
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
  /** 应用标题（关于页与窗口标题的数据源，需求 2） */
  title: string
  /** 应用描述 */
  description: string
  theme: 'light' | 'dark'
  pageSize: number
  autoSave: boolean
  sidebarCollapsed: boolean
  defaultRoute: string
}

export type RowStatus = 'active' | 'inactive'

/** SQL 标量参数（数组/对象由宿主拒绝，序列化层不放宽） */
export type DbParam = string | number | boolean | null
/** db_select 返回的行：列名 → 标量值 */
export type DbRow = Record<string, DbParam>

export interface ExecResult {
  /** 受影响行数 */
  changes: number
  /** 最近插入行的 rowid（INSERT 时有意义） */
  lastInsertId: number
}

/** 版本化迁移定义，SQL 由 repositories 层维护 */
export interface Migration {
  version: number
  description: string
  sql: string
}

/** 存储根迁移结果（需重启生效） */
export interface MigrateReport {
  from: string
  to: string
  copiedFiles: number
  /** DB 是否成功做了 WAL 检查点 */
  dbCheckpointed: boolean
}

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
