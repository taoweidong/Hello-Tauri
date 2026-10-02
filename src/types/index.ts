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
  /**
   * WeLink 助手配置（设计 §8：`config/config.json` → `AppSettings.weLink`）。
   *
   * 声明为 Partial：老配置文件里没有这个字段，读取时必须能缺省；
   * 归一化（补齐默认值 + 范围收窄）由 `normalizeWelinkSettings` 负责，
   * 调用方永远拿归一化后的完整对象。
   */
  weLink?: Partial<import('./welink').WelinkSettings>
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

/** 子进程执行结果（`cli_run` 回传）。输出为原始字节的 base64，编码判定在 TS 侧 */
export interface CliResult {
  /** 退出码；进程被超时强杀时为 null */
  exitCode: number | null
  /** stdout 原始字节的 base64 */
  stdout: string
  /** stderr 原始字节的 base64 */
  stderr: string
  stdoutTruncated: boolean
  stderrTruncated: boolean
  timedOut: boolean
  durationMs: number
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

// —— Windows 基础设施通道（windows-infra-foundation，design D5）——

/** 系统概要（`sys_overview` 回传） */
export interface SysOverview {
  /** 如 "Windows 11 专业版"（注册表 ProductName） */
  osName: string
  /** 如 "23H2 build 22631"（DisplayVersion + CurrentBuildNumber） */
  osVersion: string
  /** 目标架构（x86_64 / aarch64） */
  arch: string
  /** 计算机名 */
  hostname: string
  /** 当前用户名 */
  username: string
  /** 应用数据根绝对路径 */
  dataRoot: string
}

/** 磁盘分区（`sys_disks` 回传） */
export interface SysDisk {
  /** 盘符（如 "C"） */
  letter: string
  totalBytes: number
  /** 调用者可用空间 */
  freeBytes: number
}

/** 网络适配器（`sys_adapters` 回传） */
export interface SysAdapter {
  /** 适配器友好名（如 "以太网"、"WLAN"） */
  name: string
  /** OperStatus == Up */
  enabled: boolean
  /** 首个 IPv4 单播地址；无则 null */
  ipv4: string | null
}

/**
 * 探测/尽力而为类宿主调用的统一结果（Bridge 层「永不 reject」语义）。
 * 成功带 `data`；失败时 `reason` 必填、`detail` 可选（底层异常串）。
 */
export type ProbeResult<T> = { ok: true; data: T } | { ok: false; reason: string; detail?: string }

/** 动作型结果（打开/写入/通知等无载荷操作），同样永不 reject */
export interface BasicOutcome {
  ok: boolean
  reason?: string
  detail?: string
}
