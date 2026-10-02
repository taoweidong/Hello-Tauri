import { invoke } from '@tauri-apps/api/core'

import type {
  AppInfo,
  BasicOutcome,
  CliResult,
  DbParam,
  DbRow,
  ExecResult,
  LogLevel,
  Migration,
  MigrateReport,
  ProbeResult,
  StorageLayout,
  SysAdapter,
  SysDisk,
  SysOverview,
} from '@/types'
import type { Bridge } from './types'

/** 探测/动作类调用的统一折叠：宿主异常 → 结果对象（Bridge「永不 reject」契约） */
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function probe<T>(run: () => Promise<T>): Promise<ProbeResult<T>> {
  try {
    return { ok: true, data: await run() }
  } catch (error) {
    return { ok: false, reason: '宿主调用失败', detail: errorText(error) }
  }
}

async function act(run: () => Promise<void>): Promise<BasicOutcome> {
  try {
    await run()
    return { ok: true }
  } catch (error) {
    return { ok: false, reason: '宿主调用失败', detail: errorText(error) }
  }
}

export const tauriBridge: Bridge = {
  platform: 'tauri',
  loadConfig: () => invoke<string | null>('load_config'),
  saveConfig: (content) => invoke<void>('save_config', { content }),
  readTable: () => invoke<string | null>('read_table'),
  writeTable: (content) => invoke<void>('write_table', { content }),
  appendLog: (level: LogLevel, message: string) => invoke<string>('append_log', { level, message }),
  storageInfo: () => invoke<StorageLayout>('storage_info'),
  storageMigrate: (path: string) => invoke<MigrateReport>('storage_migrate', { path }),
  openStorageDir: () => invoke<void>('open_storage_dir'),
  appInfo: () => invoke<AppInfo>('app_info'),
  fsRead: (relative: string) => invoke<string | null>('fs_read', { relative }),
  fsWrite: (relative: string, content: string) => invoke<string>('fs_write', { relative, content }),
  dbExecute: (sql: string, params: DbParam[] = []) => invoke<ExecResult>('db_execute', { sql, params }),
  dbSelect: (sql: string, params: DbParam[] = []) => invoke<DbRow[]>('db_select', { sql, params }),
  dbTransaction: (statements: { sql: string; params?: DbParam[] }[]) =>
    invoke<number[]>('db_transaction', { statements }),
  dbMigrate: (migrations: Migration[]) => invoke<number[]>('db_migrate', { migrations }),
  cliRun: (program: string, args: string[], timeoutMs?: number) =>
    invoke<CliResult>('cli_run', { program, args, timeoutMs }),

  // —— Windows 基础设施通道（命令实位 src-tauri/src/sysinfo.rs / shell.rs）——
  sysOverview: () => probe(() => invoke<SysOverview>('sys_overview')),
  sysEnvVar: (name: string) => probe(async () => invoke<string | null>('sys_env_var', { name })),
  sysDisks: () => probe(() => invoke<SysDisk[]>('sys_disks')),
  sysAdapters: () => probe(() => invoke<SysAdapter[]>('sys_adapters')),
  shellOpen: (target: string) => act(() => invoke<void>('shell_open', { target })),
  clipboardRead: () => probe(async () => invoke<string | null>('clipboard_read')),
  clipboardWrite: (text: string) => act(() => invoke<void>('clipboard_write', { text })),
  notifySend: (title: string, body: string) => act(() => invoke<void>('notify_send', { title, body })),
}
