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

export type Platform = 'tauri' | 'web'

/**
 * 宿主 → 前端事件白名单（service-residency T-H）。Rust 侧常量见 `src-tauri/src/tray.rs`，
 * 两侧名单必须逐字一致；新增事件名 = 同时改两份常量表 + web 侧 no-op。
 */
export type HostEventName = 'host://window-hidden' | 'host://window-shown' | 'host://tray-toggle'

/** 关窗行为（T-B，config.json `AppSettings.closeBehavior`；老配置缺省 = 'tray'） */
export type CloseBehavior = 'tray' | 'quit'

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
  /**
   * 读旧版 `table.json`（A-2）。
   *
   * @deprecated 只作为 v1 数据升级的数据源保留，新代码一律走 `fsRead` /
   * SQLite 仓储。**移除条件**：确认现场实例的 `records` 表已全部由
   * `migrationV1` 建起、且 `records.ts` 的 `prepare()` 不再需要从
   * `table.json` 导入历史数据后，连同 `writeTable` 与 `tauri.rs` 的
   * `read_table` / `write_table` 一起删除。
   */
  readTable(): Promise<string | null>
  /** @deprecated 见 `readTable` 的移除条件；旧版 `table.json` 已不再写入 */
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

  // —— 子进程通道（Q1 同构：Rust 只做薄管道，命令名/参数/编码全在 TS） ——

  /**
   * 执行白名单内的命令行程序（`welink-cli`、`codehub-cli`（CodeHub MR 检视拉取）、
   * `python`/`python3`/`py`，白名单实位在 `src-tauri/src/cli.rs` 的 `ALLOWED_STEMS`）。
   *
   * 三条契约（两侧实现必须一致）：
   *  * 输出以 **base64** 回传（编码判定在 TS：UTF-8 严格 → GBK 兜底）；
   *  * 退出码非 0 **不算失败**：不 reject，由调用方按业务判定；
   *  * 只有通道故障（程序名不在白名单、进程起不来）才 reject。
   */
  cliRun(program: string, args: string[], timeoutMs?: number): Promise<CliResult>

  // —— HTTP JSON POST 通道（大模型对接，与 cliRun 同构的薄通道：Rust 只转发） ——

  /**
   * 以宿主进程身份 POST JSON。大模型服务不回 CORS 头（2026-10-04 对阿里云 MaaS
   * 实测），WebView 的 `window.fetch` 会被浏览器层拦截，请求必须在宿主进程内发出；
   * URL/头/体全部由 TS 侧组装（`src/infra/agent/agent-http.ts`），Rust 无业务规则。
   *
   * 契约（两侧实现必须一致，同 cliRun）：
   *  * 收到 HTTP 响应（含 4xx/5xx）**不算失败**：状态码与正文原样回传，由调用方按业务判定；
   *  * 只有传输层故障（DNS 失败、TLS 握手失败、超时）才 reject；
   *  * 超时在宿主侧强制生效（TS 侧另有同值超时做错误分类）。
   */
  httpPostJson(url: string, headers: Record<string, string>, body: string, timeoutMs: number): Promise<HttpPostResult>

  // —— Windows 基础设施通道（windows-infra-foundation）——
  //
  // 结果语义分层（design D5）：下列方法 **永不 reject**，一切失败折叠进结果
  // 对象（ok:false + reason [+ detail]）；调用方无需 try/catch。
  // 命令执行不在此列：走上方 cliRun 的既有契约（仅通道故障 reject）。

  /** 系统概要探测（OS 版本/架构/主机名/用户/数据根） */
  sysOverview(): Promise<ProbeResult<SysOverview>>
  /** 按名读取当前进程环境变量；不存在返回 data:null（不是失败） */
  sysEnvVar(name: string): Promise<ProbeResult<string | null>>
  /** 磁盘分区枚举（盘符/容量/可用空间） */
  sysDisks(): Promise<ProbeResult<SysDisk[]>>
  /** 网络适配器枚举（友好名/启用状态/首个 IPv4） */
  sysAdapters(): Promise<ProbeResult<SysAdapter[]>>
  /** 用系统默认程序打开 http/https URL 或本地文件/目录 */
  shellOpen(target: string): Promise<BasicOutcome>
  /** 读剪贴板纯文本；剪贴板无文本内容时 data:null（不是失败） */
  clipboardRead(): Promise<ProbeResult<string | null>>
  /** 向剪贴板写入纯文本（覆盖现有内容） */
  clipboardWrite(text: string): Promise<BasicOutcome>
  /** 发出系统通知（标题 + 正文）；能力不可用时返回未送达结果 */
  notifySend(title: string, body: string): Promise<BasicOutcome>

  // —— 服务常驻通道（service-residency）——
  // 结果语义与 Windows 基础设施层一致（永不 reject，失败折叠进结果对象）。

  /** 订阅宿主事件；返回退订函数。浏览器侧恒 no-op（永不 reject） */
  onHostEvent(name: HostEventName, handler: () => void): Promise<() => void>
  /** 服务状态回写托盘（菜单动态文案 + tooltip）；单一真值在前端 store.status（T-K） */
  traySetStatus(running: boolean, statusText: string): Promise<BasicOutcome>
  /**
   * 关窗策略下发：前端是唯一读 config 的人，Rust 不碰配置文件（T-B/T-L）。
   * 变更生效链路：SettingsView 编辑 → appStore（autoSave 落盘）→ App.vue watch 下发。
   */
  traySetClosePolicy(policy: CloseBehavior): Promise<BasicOutcome>
  /** 开机自启：真值在注册表 HKCU Run 项、不入 config.json（T-I，避免双真值漂移） */
  autostartGet(): Promise<ProbeResult<boolean>>
  autostartSet(enabled: boolean): Promise<ProbeResult<boolean>>
}
