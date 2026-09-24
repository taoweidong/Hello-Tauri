import type { AppInfo, DbParam, DbRow, ExecResult, LogLevel, Migration, MigrateReport, StorageLayout } from '@/types'

export type Platform = 'tauri' | 'web'

/**
 * 前端与宿主环境之间的唯一边界。
 *
 * 桌面端由 Rust 命令实现，浏览器端为语义等价实现（仅用于开发调试，Q3：不做真 SQL）。
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
  /** 迁移存储根到新的绝对路径（复制迁移、旧目录保留；需重启生效）。仅桌面模式可用 */
  storageMigrate(path: string): Promise<MigrateReport>
  /** 在系统文件管理器中打开存储目录 */
  openStorageDir(): Promise<void>
  appInfo(): Promise<AppInfo>

  // —— 文件读写通道（相对存储根，Rust 侧防路径穿越） ——
  /** 读存储根下的文本文件，不存在返回 null */
  fsRead(relative: string): Promise<string | null>
  /** 写存储根下的文本文件（自动建父目录），返回落盘绝对路径 */
  fsWrite(relative: string, content: string): Promise<string>

  // —— SQLite 通用通道（Q1：SQL 留在 TS 仓储层，Rust 只做通用执行） ——

  /** 执行 INSERT/UPDATE/DELETE/DDL；参数按 ?1 ?2 … 占位符绑定 */
  dbExecute(sql: string, params?: DbParam[]): Promise<ExecResult>
  /** 执行 SELECT，返回「列名 → 标量值」的行数组 */
  dbSelect(sql: string, params?: DbParam[]): Promise<DbRow[]>
  /** 事务：按序执行多条语句，任一失败整体回滚；返回各语句受影响行数 */
  dbTransaction(statements: { sql: string; params?: DbParam[] }[]): Promise<number[]>
  /** 版本化迁移（宿主侧 _migrations 表跟踪），返回本次新应用的版本号 */
  dbMigrate(migrations: Migration[]): Promise<number[]>
}