import { invoke } from '@tauri-apps/api/core'
// service-residency：宿主事件通道（托盘动作 / 窗口显隐 → 前端决策，T-H）
import { listen } from '@tauri-apps/api/event'

import type {
  AppInfo,
  BasicOutcome,
  CliResult,
  DbParam,
  DbRow,
  ExecResult,
  HttpPostResult,
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
  // headers 以二元组数组回传（serde Vec<(String, String)>），Rust 侧逐条塞进请求头
  httpPostJson: (url: string, headers: Record<string, string>, body: string, timeoutMs: number) =>
    invoke<HttpPostResult>('http_post_json', { url, headers: Object.entries(headers), body, timeoutMs }),

  // —— Windows 基础设施通道（命令实位 src-tauri/src/sysinfo.rs / shell.rs）——
  sysOverview: () => probe(() => invoke<SysOverview>('sys_overview')),
  sysEnvVar: (name: string) => probe(async () => invoke<string | null>('sys_env_var', { name })),
  sysDisks: () => probe(() => invoke<SysDisk[]>('sys_disks')),
  sysAdapters: () => probe(() => invoke<SysAdapter[]>('sys_adapters')),
  shellOpen: (target: string) => act(() => invoke<void>('shell_open', { target })),
  clipboardRead: () => probe(async () => invoke<string | null>('clipboard_read')),
  clipboardWrite: (text: string) => act(() => invoke<void>('clipboard_write', { text })),
  notifySend: (title: string, body: string) => act(() => invoke<void>('notify_send', { title, body })),

  // —— 服务常驻通道（命令实位 src-tauri/src/tray.rs / autostart.rs）——
  onHostEvent: (name, handler) =>
    // listen 的 Promise reject 只发生在注册通道故障；按 act 语义折叠为「空退订」，
    // 调用方永远拿到一个可安全调用的函数（永不 reject）
    listen(name, () => handler())
      .then((unlisten) => () => void unlisten())
      .catch(() => () => {}),
  traySetStatus: (running, statusText) => act(() => invoke<void>('tray_set_status', { running, statusText })),
  traySetClosePolicy: (policy) => act(() => invoke<void>('tray_set_close_policy', { policy })),
  autostartGet: () => probe(() => invoke<boolean>('autostart_get')),
  autostartSet: (enabled) => probe(() => invoke<boolean>('autostart_set', { enabled })),
}
