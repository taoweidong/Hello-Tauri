import type {
  AppInfo,
  BasicOutcome,
  CliResult,
  DbParam,
  DbRow,
  ExecResult,
  LogLevel,
  Migration,
  ProbeResult,
  StorageLayout,
  SysAdapter,
  SysDisk,
  SysOverview,
} from '@/types'
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
  async storageMigrate(_path: string) {
    throw new Error('浏览器调试模式不支持迁移存储目录')
  },
  async openStorageDir() {
    throw new Error('浏览器调试模式不支持打开本地目录')
  },
  // 文件通道与 db 通道同理：浏览器无磁盘写入语义，诚实抛错，视图层自行降级为下载。
  async fsRead(_relative: string): Promise<string | null> {
    throw new Error('浏览器调试模式不支持读取本地文件')
  },
  async fsWrite(_relative: string, _content: string): Promise<string> {
    throw new Error('浏览器调试模式不支持写入本地文件，将改用浏览器下载')
  },
  async appInfo() {
    return {
      name: 'Hello-Tauri',
      // R-3：版本取构建期注入的常量（真值在 package.json），不再手工同步
      version: __APP_VERSION__,
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
  // —— 子进程通道：浏览器没有进程模型。这里**明确报错**而不是返回假数据 ——
  //    设计 §3.3 的「web 模式可用 mock 跑通全链路」由 infra/welink 与
  //    infra/codehub 工厂实现：浏览器下两者都强制 mock 数据源，mock 端口根本
  //    不经过 CLI，因此本方法永远不会被业务路径调用。保留它只为 Bridge 契约两侧对齐。
  async cliRun(_program: string, _args: string[], _timeoutMs?: number): Promise<CliResult> {
    throw new Error('浏览器调试模式不支持执行本地命令，WeLink/CodeHub 数据源请使用 mock')
  },

  // —— Windows 基础设施通道 ——
  //    系统信息：浏览器无宿主进程概念，返回 [MOCK-WIN] 标注的模拟数据（结构一致）。
  //    Shell 交互：走浏览器等价 API（window.open / clipboard / Notification），
  //    失败折叠为结果对象 —— 与桌面同契约，永不 reject。

  async sysOverview(): Promise<ProbeResult<SysOverview>> {
    return {
      ok: true,
      data: {
        osName: '[MOCK-WIN] Windows 11 专业版',
        osVersion: '[MOCK-WIN] 23H2 build 22631',
        arch: 'x86_64',
        hostname: 'mock-hostname',
        username: 'mock-user',
        dataRoot: WEB_LAYOUT.root,
      },
    }
  },
  async sysEnvVar(_name: string): Promise<ProbeResult<string | null>> {
    // 浏览器无进程环境变量语义：按「变量不存在」返回空结果（spec 允许，不是失败）
    return { ok: true, data: null }
  },
  async sysDisks(): Promise<ProbeResult<SysDisk[]>> {
    return {
      ok: true,
      data: [
        { letter: 'C', totalBytes: 512_110_190_592, freeBytes: 128_849_018_880 },
        { letter: 'D', totalBytes: 1_000_203_481_088, freeBytes: 644_245_094_400 },
      ],
    }
  },
  async sysAdapters(): Promise<ProbeResult<SysAdapter[]>> {
    return {
      ok: true,
      data: [
        { name: '[MOCK-WIN] 以太网', enabled: true, ipv4: '192.168.1.100' },
        { name: '[MOCK-WIN] WLAN', enabled: false, ipv4: null },
      ],
    }
  },
  async shellOpen(target: string): Promise<BasicOutcome> {
    if (/^https?:\/\//.test(target)) {
      const opened = window.open(target, '_blank', 'noopener')
      return opened ? { ok: true } : { ok: false, reason: '浏览器拦截了弹窗，请允许后重试' }
    }
    return { ok: false, reason: '浏览器调试模式仅支持 http/https 打开，本地路径请在桌面模式使用' }
  },
  async clipboardRead(): Promise<ProbeResult<string | null>> {
    try {
      if (!navigator.clipboard?.readText) {
        return { ok: false, reason: '当前浏览器不支持剪贴板读取 API' }
      }
      const text = await navigator.clipboard.readText()
      return { ok: true, data: text === '' ? null : text }
    } catch (error) {
      // NotFoundError = 剪贴板无文本格式（非文本内容），按「空结果」处理而非失败
      const name = error instanceof DOMException ? error.name : ''
      if (name === 'NotFoundError') return { ok: true, data: null }
      return { ok: false, reason: '浏览器剪贴板读取失败（权限被拒或环境不支持）', detail: String(error) }
    }
  },
  async clipboardWrite(text: string): Promise<BasicOutcome> {
    try {
      if (!navigator.clipboard?.writeText) {
        return { ok: false, reason: '当前浏览器不支持剪贴板写入 API' }
      }
      await navigator.clipboard.writeText(text)
      return { ok: true }
    } catch (error) {
      return { ok: false, reason: '浏览器剪贴板写入失败（权限被拒或环境不支持）', detail: String(error) }
    }
  },
  async notifySend(title: string, body: string): Promise<BasicOutcome> {
    if (typeof Notification === 'undefined') {
      return { ok: false, reason: '当前浏览器不支持 Notification API' }
    }
    try {
      const permission = Notification.permission === 'default' ? await Notification.requestPermission() : Notification.permission
      if (permission !== 'granted') {
        return { ok: false, reason: '浏览器通知权限未授予' }
      }
      new Notification(title, { body })
      return { ok: true }
    } catch (error) {
      return { ok: false, reason: '浏览器通知发送失败', detail: String(error) }
    }
  },
}
