/**
 * 自动更新编排（design-auto-update §4.2/§4.3/§11.4）。
 *
 * 职责边界：状态机、触发调度（手动/启动延迟/周期/摆渡扫描）、节流、版本判定、
 * 下载与安装编排、apply 前的服务暂停 —— 业务规则全在这里；宿主（Rust update.rs）
 * 只做字节搬运与进程自替换。任何异常都不得比「不更新」更糟：检查失败静默记日志
 * （手动触发由 UI 呈现），安装失败折叠进 failed 状态等用户重试。
 *
 * 状态机（§4.3）：
 *   idle → checking → up-to-date（记 lastCheckAt）/ available（semver > 当前）
 *   available → downloading（进度事件）→ verifying → ready → applying →（宿主退出重启）
 *   摆渡：idle →（扫描 inbox 命中）→ verifying → ready（跳过下载，apply 时复核 sha）
 *   任一环节失败 → failed{step, reason}（用户重试 / 下个调度周期恢复）
 *
 * apply 契约（与 update.rs 对齐）：成功场景宿主在 200ms 后退出、响应一般可达；
 * 「宽限期内响应未达」时本模块代码仍在执行 = 进程存活且通道异常（进程若已退出，
 * JS 上下文不会存活到超时点），据此给出如实的失败态而不误报成功。
 */
import type { ApplyOutcome } from '@/types'
import { pickPlatform, UpdateError, type ManifestSource, type UpdateClient, type UpdateManifest } from '@/infra/update'
import type { UpdateSettings } from '@/types/update'
import { compareSemVer } from '@/utils/semver'
import { logger } from '@/utils/logger'
import { realTimers, type TimerApi } from './timers'

export type UpdateState =
  | 'idle'
  | 'checking'
  | 'up-to-date'
  | 'available'
  | 'downloading'
  | 'verifying'
  | 'ready'
  | 'applying'
  | 'failed'

export interface UpdateStatus {
  state: UpdateState
  latest: { version: string; notes: string; minVersion: string | null } | null
  progress: { received: number; total: number | null } | null
  error: { step: string; reason: string } | null
  /** 最近一次检查时间（ISO 串；持久化于 update/state.json，节流依据） */
  lastCheckAt: string | null
  /**
   * 跨重启「发现过新版本」提示（上次检查见过、尚未安装成功的版本号）。
   * 与 state=available 并存时以 state 为准；仅用于工作台小红点的重启前兜底显示。
   */
  hintVersion: string | null
}

export type CheckSource = 'manual' | 'startup' | 'schedule' | 'inbox'

/** update/state.json 的持久化形状（程序状态，非用户配置） */
export interface UpdatePersistedState {
  lastCheckAt: string | null
  lastVersionSeen: string | null
}

export interface UpdaterDeps {
  client: UpdateClient
  settings: () => UpdateSettings
  /** 当前运行版本（appInfo().version / __APP_VERSION__） */
  currentVersion: string
  /** apply 前停服务（WeLink 轮询/管线 + CodeHub 自动同步），注入以解耦各域 store */
  pauseServices: () => Promise<void>
  loadState: () => Promise<UpdatePersistedState | null>
  saveState: (state: UpdatePersistedState) => Promise<void>
  /** spawn 失败档的系统通知（失败表 #9）；不注入则跳过 */
  notify?: (title: string, body: string) => void
  now?: () => number
  timers?: TimerApi
  /** 启动延迟检查（默认 10s；测试传 0） */
  startupDelayMs?: number
  /** 周期对表唤醒间隔（默认 30min；checkIntervalHours 节流在 checkNow 内） */
  periodicIntervalMs?: number
  /** apply 响应宽限（默认 3s；测试传小值） */
  applyGraceMs?: number
}

export interface Updater {
  /** 装配调度（幂等）：恢复持久化提示 + 启动延迟检查 + 周期对表 */
  init(): void
  getStatus(): UpdateStatus
  onStatus(cb: (status: UpdateStatus) => void): () => void
  checkNow(source: CheckSource): Promise<UpdateStatus>
  /** available/ready/failed（有清单）→ 下载（在线）→ ready →（auto 模式）apply */
  install(): Promise<void>
  /** 扫描摆渡目录（update/inbox/），命中走与在线同一管线 */
  scanInbox(): Promise<void>
  dispose(): void
}

export function emptyStatus(): UpdateStatus {
  return { state: 'idle', latest: null, progress: null, error: null, lastCheckAt: null, hintVersion: null }
}

const STARTUP_DELAY_MS = 10_000
const PERIODIC_INTERVAL_MS = 30 * 60_000
const APPLY_GRACE_MS = 3_000
const HOUR_MS = 3_600_000

/** 正在进行的流转（这些状态下忽略新触发，防重入/双击） */
function isBusy(state: UpdateState): boolean {
  return state === 'checking' || state === 'downloading' || state === 'verifying' || state === 'applying'
}

export function createUpdater(deps: UpdaterDeps): Updater {
  const now = deps.now ?? (() => Date.now())
  const timers = deps.timers ?? realTimers
  const startupDelayMs = deps.startupDelayMs ?? STARTUP_DELAY_MS
  const periodicIntervalMs = deps.periodicIntervalMs ?? PERIODIC_INTERVAL_MS
  const applyGraceMs = deps.applyGraceMs ?? APPLY_GRACE_MS

  let status: UpdateStatus = emptyStatus()
  let manifest: UpdateManifest | null = null
  let source: ManifestSource = 'remote'
  let lastVersionSeen: string | null = null
  let inited = false
  let disposed = false
  let startupTimer: unknown = null
  let periodicTimer: unknown = null
  let listeners: Array<(status: UpdateStatus) => void> = []

  function emit(): void {
    const snapshot = { ...status }
    for (const cb of listeners) {
      try {
        cb(snapshot)
      } catch {
        // 监听者异常不反噬状态机
      }
    }
  }

  function setStatus(patch: Partial<UpdateStatus>): void {
    status = { ...status, ...patch }
    emit()
  }

  /**
   * 检查发起即记 lastCheckAt（成败都记：防故障服务器被调度高频重试打穿）。
   * lastVersionSeen：seen 传入=见过新版本；clear=清单已不新（清除跨重启提示）；
   * 都不传=检查失败（保留上次的提示记忆）。
   */
  async function recordCheck(outcome: { seen?: string; clear?: boolean } = {}): Promise<void> {
    status.lastCheckAt = new Date(now()).toISOString()
    if (outcome.seen !== undefined) lastVersionSeen = outcome.seen
    else if (outcome.clear) lastVersionSeen = null
    try {
      await deps.saveState({ lastCheckAt: status.lastCheckAt, lastVersionSeen })
    } catch (error) {
      logger.warn('更新状态落盘失败（节流可能失效）', error)
    }
  }

  function failFrom(error: unknown): void {
    const step = error instanceof UpdateError ? error.step : 'network'
    const reason = error instanceof Error ? error.message : String(error)
    logger.warn(`更新流程失败（${step}）: ${reason}`)
    setStatus({ state: 'failed', error: { step, reason }, progress: null })
  }

  function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => timers.set(resolve, ms))
  }

  async function restore(): Promise<void> {
    const persisted = await deps.loadState().catch(() => null)
    if (!persisted) return
    lastVersionSeen = persisted.lastVersionSeen ?? null
    const patch: Partial<UpdateStatus> = {}
    if (persisted.lastCheckAt) patch.lastCheckAt = persisted.lastCheckAt
    // 上次检查见过新版本且尚未装上：跨重启保留「可更新」提示（小红点不必等下一次检查）
    if (
      persisted.lastVersionSeen &&
      deps.settings().enabled &&
      compareSemVer(persisted.lastVersionSeen, deps.currentVersion) > 0
    ) {
      patch.hintVersion = persisted.lastVersionSeen
      logger.info(`恢复更新提示：上次检查发现新版本 ${persisted.lastVersionSeen}（当前 ${deps.currentVersion}）`)
    }
    if (Object.keys(patch).length) setStatus(patch)
  }

  async function applyNow(): Promise<void> {
    const target = manifest
    if (!target) return
    setStatus({ state: 'applying', error: null })
    // U-J：apply 前停轮询/管线，避免替换瞬间还有在飞外发任务；失败尽力而为继续
    try {
      await deps.pauseServices()
      logger.info('更新前已暂停后台服务（重启后由 bootstrap 恢复）')
    } catch (error) {
      logger.warn('更新前暂停服务失败（继续替换，重启后 bootstrap 兜底）', error)
    }
    let staged: string
    try {
      staged = deps.client.stagedRelative(target, source)
    } catch (error) {
      failFrom(error)
      return
    }
    const sha256 = pickPlatform(target).sha256
    logger.info(`开始自替换：${staged}（${deps.currentVersion} → ${target.version}）`)

    const outcome: ApplyOutcome | null = await Promise.race([
      deps.client.apply(staged, sha256).then(
        (value) => value,
        (error: unknown) =>
          ({ ok: false, step: 'locate', rolledBack: false, reason: error instanceof Error ? error.message : String(error) }) as ApplyOutcome,
      ),
      sleep(applyGraceMs).then(() => null),
    ])

    if (outcome === null) {
      // 宽限期内响应未达：进程若已按预期退出，本代码不会执行 —— 执行到这里说明
      // 进程仍存活且通道异常（病态场景），如实报失败引导手动重启。
      setStatus({ state: 'failed', error: { step: 'apply', reason: '自替换无响应（进程未按预期退出），请手动重启应用' } })
      return
    }
    if (outcome.ok) {
      logger.info(`自替换已发起：应用即将重启到 ${target.version}（WAL 已持久，业务由 bootstrap 恢复）`)
      // ok:true 但进程迟迟不退（浏览器 mock：本就没有进程可换）→ 宽限后如实呈现
      await sleep(applyGraceMs)
      setStatus({
        state: 'failed',
        error: { step: 'apply', reason: '更新流程已走完，但进程未自动重启，请手动重启应用' },
      })
      return
    }
    // 失败映射（§8）：Rust 的 reason 已是面向用户的文案；spawn 档补系统通知（尽力而为）
    if (outcome.step === 'spawn') {
      try {
        deps.notify?.('更新完成', `新版本 ${target.version} 已就位，自动重启失败，请手动双击启动应用`)
      } catch {
        // 通知失败不改变处置
      }
    }
    setStatus({ state: 'failed', error: { step: outcome.step ?? 'apply', reason: outcome.reason ?? '自替换失败' } })
  }

  const updater: Updater = {
    init() {
      if (inited || disposed) return
      inited = true
      // restore 先于启动检查：lastCheckAt 恢复后节流才可信（否则每次重启都会多查一次）
      void restore().then(() => {
        if (disposed) return
        startupTimer = timers.set(() => {
          // 启动检查（在线）完成后扫一次摆渡目录：串行避免双检查竞态；
          // 在线检查命中时 install/auto 流转会让 inbox 检查被 busy 闸跳过。
          void updater.checkNow('startup').then(() => updater.scanInbox())
        }, startupDelayMs)
      })
      periodicTimer = timers.set(function tick() {
        void updater.checkNow('schedule')
        periodicTimer = timers.set(tick, periodicIntervalMs)
      }, periodicIntervalMs)
    },

    getStatus() {
      return { ...status }
    },

    onStatus(cb) {
      listeners.push(cb)
      return () => {
        listeners = listeners.filter((item) => item !== cb)
      }
    },

    async checkNow(requested): Promise<UpdateStatus> {
      const requestedSource = requested
      if (disposed) return { ...status }
      const settings = deps.settings()
      if (isBusy(status.state)) return { ...status }
      if (!settings.enabled) {
        logger.info(`更新检查跳过：自动更新未启用（source=${requestedSource}）`)
        return { ...status }
      }
      if (requestedSource !== 'inbox' && !settings.endpoint.trim()) {
        logger.info('更新检查跳过：未配置更新服务器端点')
        return { ...status }
      }
      // 节流：manual 与 inbox（本地读）绕过；startup/schedule 距上次检查不足间隔则跳过
      if (requestedSource === 'startup' || requestedSource === 'schedule') {
        const last = status.lastCheckAt ? Date.parse(status.lastCheckAt) : NaN
        const elapsed = now() - last
        if (Number.isFinite(last) && elapsed >= 0 && elapsed < settings.checkIntervalHours * HOUR_MS) {
          logger.info(
            `更新检查跳过：距上次检查不足 ${settings.checkIntervalHours}h（source=${requestedSource}）`,
          )
          return { ...status }
        }
      }

      setStatus({ state: 'checking', error: null })
      try {
        const found =
          requestedSource === 'inbox' ? await deps.client.fetchInbox() : await deps.client.fetchRemote(settings.endpoint)
        if (found === null) {
          await recordCheck({ clear: true })
          setStatus({ state: 'up-to-date', hintVersion: null })
          logger.info('更新检查完成：暂无更新清单')
          return { ...status }
        }
        const comparison = compareSemVer(found.version, deps.currentVersion)
        if (comparison <= 0) {
          // 降级/相同清单：不提示不安装（U-H），并清除「上次见过新版本」的记忆
          await recordCheck({ clear: true })
          setStatus({ state: 'up-to-date', hintVersion: null })
          logger.info(`更新检查完成：远端 ${found.version} ≤ 当前 ${deps.currentVersion}，按最新处理（U-H）`)
          return { ...status }
        }
        await recordCheck({ seen: found.version })
        manifest = found
        source = requestedSource === 'inbox' ? 'inbox' : 'remote'
        setStatus({
          state: 'available',
          latest: { version: found.version, notes: found.notes, minVersion: found.minVersion ?? null },
          error: null,
          hintVersion: null,
        })
        logger.info(`发现新版本 ${found.version}（当前 ${deps.currentVersion}，来源=${source}）`)
        if (settings.mode === 'auto') await updater.install()
      } catch (error) {
        await recordCheck({}).catch(() => {})
        failFrom(error)
      }
      return { ...status }
    },

    async install(): Promise<void> {
      const target = manifest
      if (!target || !(status.state === 'available' || status.state === 'ready' || status.state === 'failed')) {
        return
      }
      if (status.state === 'ready') {
        // 已就绪（notify 模式人工点装 / 失败后重试）：跳过下载直接安装
        await applyNow()
        return
      }
      if (
        status.state === 'failed' &&
        status.error?.step &&
        ['locate', 'probe', 'copy', 'rename_current', 'rename_staged', 'spawn', 'apply'].includes(status.error.step)
      ) {
        // 替换阶段的失败（如 rename 被占用、目录不可写）：staged 文件仍然有效，
        // apply 会复核 sha256 —— 重试无需重新下载（失败表 #8 的「关闭副本后重试」路径）
        await applyNow()
        return
      }
      if (source === 'inbox') {
        // 摆渡：exe 已在本地，跳过下载；sha256 由 update_apply 安装时复核（闸①覆盖摆渡路径）
        setStatus({ state: 'verifying' })
        setStatus({ state: 'ready', progress: null })
        logger.info(`摆渡新版本 ${target.version} 已就绪（安装时复核 sha256）`)
        if (deps.settings().mode === 'auto') await applyNow()
        return
      }
      setStatus({ state: 'downloading', progress: { received: 0, total: null }, error: null })
      try {
        const outcome = await deps.client.download(target, {
          endpoint: deps.settings().endpoint,
          onProgress: (progress) => setStatus({ progress }),
        })
        // 双保险（Rust update_download 已按 expected sha 收尾并删除坏文件）：大小写不敏感比对
        if (outcome.sha256.toLowerCase() !== pickPlatform(target).sha256.toLowerCase()) {
          throw new UpdateError('sha', '下载内容校验失败，请重试')
        }
        setStatus({ state: 'verifying' })
        setStatus({ state: 'ready', progress: null })
        logger.info(`新版本 ${target.version} 已下载并通过完整性校验（${outcome.bytes} 字节）`)
        if (deps.settings().mode === 'auto') await applyNow()
      } catch (error) {
        failFrom(error)
      }
    },

    async scanInbox(): Promise<void> {
      await updater.checkNow('inbox')
    },

    dispose() {
      disposed = true
      if (startupTimer !== null) timers.clear(startupTimer)
      if (periodicTimer !== null) timers.clear(periodicTimer)
      startupTimer = null
      periodicTimer = null
      listeners = []
    },
  }

  return updater
}
