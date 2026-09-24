import { invoke } from '@tauri-apps/api/core'

import type { AppInfo, DbParam, DbRow, ExecResult, LogLevel, Migration, MigrateReport, StorageLayout } from '@/types'
import type { Bridge } from './types'

export const tauriBridge: Bridge = {
  platform: 'tauri',
  loadConfig: () => invoke<string | null>('load_config'),
  saveConfig: (content) => invoke<void>('save_config', { content }),
  readTable: () => invoke<string | null>('read_table'),
  writeTable: (content) => invoke<void>('write_table', { content }),
  appendLog: (level: LogLevel, message: string) =>
    invoke<string>('append_log', { level, message }),
  storageInfo: () => invoke<StorageLayout>('storage_info'),
  storageMigrate: (path: string) => invoke<MigrateReport>('storage_migrate', { path }),
  openStorageDir: () => invoke<void>('open_storage_dir'),
  appInfo: () => invoke<AppInfo>('app_info'),
  fsRead: (relative: string) => invoke<string | null>('fs_read', { relative }),
  fsWrite: (relative: string, content: string) =>
    invoke<string>('fs_write', { relative, content }),
  dbExecute: (sql: string, params: DbParam[] = []) =>
    invoke<ExecResult>('db_execute', { sql, params }),
  dbSelect: (sql: string, params: DbParam[] = []) =>
    invoke<DbRow[]>('db_select', { sql, params }),
  dbTransaction: (statements: { sql: string; params?: DbParam[] }[]) =>
    invoke<number[]>('db_transaction', { statements }),
  dbMigrate: (migrations: Migration[]) => invoke<number[]>('db_migrate', { migrations }),
}