/**
 * CodeHub 同步管线（design D5）——把内网 CodeHub 的 MR 快照同步进本地库。
 *
 * 与 welink 轮询器（`poller.ts`）同构的三条硬约束：
 *
 *  1. **single-flight + setTimeout 链**：弃用 `setInterval`，本轮**完成**（含失败）
 *     之后才排下一轮；手动刷新与自动轮询共用同一把 in-flight 锁，连点不会并发。
 *  2. **失败退避**：整轮失败按 SYNC_BACKOFF_STEPS 推迟下一轮自动同步；
 *     手动刷新不受退避限制（用户显式动作），成功即清零退避计数。
 *  3. **单仓库失败不中断整轮**：其余仓库照常同步；但 `auth` 类失败对每个仓库都
 *     必然复现（token 坏了就是全坏），立即终止本轮 —— 对它退避重试没有意义，
 *     应该让用户去配置页修 token（spec「连接配置由用户提供」）。
 *
 * 只读域的边界：管线只做「拉取 → 快照落库」，无外发动作，不涉及 safety-gate；
 * 事件只派发状态（started/repoSynced/repoFailed/finished），快照本体由 store 从
 * 仓储读取 —— 与 welink 的「事件增量通知」约定一致。
 */
import type { CodeHubPort } from '@/infra/codehub'
import { CodeHubError } from '@/infra/codehub/port'
import type { CodeHubRepository } from '@/infra/db'
import type { CodeHubSettings } from '@/types/codehub'
import { logger } from '@/utils/logger'
import { nowStamp } from '@/utils/time'
import type { CodeHubEventSink, CodeHubSyncSummary } from './events'
import { realTimers, type TimerApi } from './timers'

/** 仓库清单一次读取的硬上限：个人工具的人工清单，超出即告警而非静默翻页 */
export const REPO_HARD_LIMIT = 100

/** 自动同步间隔下限（秒）：内网服务友好，也是配置页输入的钳制依据 */
export const SYNC_MIN_INTERVAL_SEC = 60

/**
 * 整轮失败后的退避序列（秒）：同步是分钟级任务，从 1 分钟起步、封顶 10 分钟。
 * 手动刷新不受退避限制，退避只推迟自动轮询的下一轮。
 */
export const SYNC_BACKOFF_STEPS = [60, 120, 300, 600] as const

export interface CodeHubSyncerOptions {
  repo: CodeHubRepository
  /** 端口获取函数（默认走工厂 `codeHubPort`；测试注入 mock 端口） */
  port: () => CodeHubPort
  /** 设置读取函数（每次调用取最新值，配置改动下一轮生效） */
  settings: () => CodeHubSettings
  emit: CodeHubEventSink
  timers?: TimerApi
  now?: () => Date
}

export interface CodeHubSyncer {
  /**
   * 立即同步一轮（与自动轮询共用 in-flight 锁）。**永不 reject**：一切失败
   * 折叠进摘要（phase=failed + reason），调用方直接展示即可。
   */
  refresh(): Promise<CodeHubSyncSummary>
  /** 启动自动轮询（间隔取 settings.pollIntervalSec，钳制 ≥60s；0 = 不启动） */
  startAuto(): void
  /** 停止自动轮询（清 timer；已在飞的同步让其自然结束） */
  stopAuto(): void
  autoRunning(): boolean
  /** 连续整轮失败触发的退避秒数（0 = 无退避），供 UI 显示「退避中」 */
  backoffSec(): number
  /** 永久停止（页面卸载时调用；此后 startAuto 无效） */
  dispose(): void
}

/**
 * CLI 模式下的配置完备性：不全就不该发起任何 CLI 调用（spec「未配置引导态」）。
 * mock 模式视为永远就绪 —— 浏览器调试与演示不依赖用户配置。
 */
export function codeHubConfigured(settings: CodeHubSettings): boolean {
  return settings.source !== 'cli' || (settings.cliPath.trim() !== '' && settings.token.trim() !== '')
}

export function createCodeHubSyncer(options: CodeHubSyncerOptions): CodeHubSyncer {
  const timers = options.timers ?? realTimers
  const now = options.now ?? (() => new Date())

  let timer: unknown = null
  let autoOn = false
  let disposed = false
  /** 连续失败的整轮数（成功清零）→ 退避档位索引 */
  let failedRounds = 0
  let inFlight: Promise<CodeHubSyncSummary> | null = null

  function scheduleNext(delaySec: number) {
    if (!autoOn || disposed) return
    timers.clear(timer)
    timer = timers.set(
      () => {
        timer = null
        void runRound()
      },
      Math.max(0, delaySec * 1000),
    )
  }

  /** 下一轮自动同步的延迟（秒）：基准间隔与退避取大者 */
  function nextDelaySec(): number {
    const base = Math.max(SYNC_MIN_INTERVAL_SEC, options.settings().pollIntervalSec)
    const backoff = failedRounds > 0 ? SYNC_BACKOFF_STEPS[Math.min(failedRounds - 1, SYNC_BACKOFF_STEPS.length - 1)] : 0
    return Math.max(base, backoff)
  }

  async function runRound(): Promise<CodeHubSyncSummary> {
    if (inFlight) return inFlight
    const task = (async (): Promise<CodeHubSyncSummary> => {
      const startedAt = nowStamp(now())
      options.emit({ type: 'codehubSyncStarted' })

      const settings = options.settings()
      if (!codeHubConfigured(settings)) {
        const summary: CodeHubSyncSummary = {
          phase: 'failed',
          repos: 0,
          applied: 0,
          failed: 0,
          degraded: [],
          reason: 'CodeHub 未配置：请在配置页填写 CLI 路径与访问 token',
          startedAt,
          finishedAt: nowStamp(now()),
        }
        options.emit({ type: 'codehubSyncFinished', summary })
        return summary
      }

      // 启用仓库清单（人工维护的小清单，硬上限告警而非翻页）；
      // 读清单失败属于整轮失败 —— 事件照发、摘要返回 failed，绝不向上 reject
      let repos: Array<{ repoId: string; enabled: boolean }>
      try {
        const all = await options.repo.listRepos(REPO_HARD_LIMIT)
        if (all.length >= REPO_HARD_LIMIT) {
          logger.warn(`CodeHub 仓库清单达到硬上限 ${REPO_HARD_LIMIT}，超出部分本轮不参与同步`)
        }
        repos = all.filter((repo) => repo.enabled)
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        logger.error('CodeHub 同步：读取仓库清单失败', error)
        const summary: CodeHubSyncSummary = {
          phase: 'failed',
          repos: 0,
          applied: 0,
          failed: 0,
          degraded: [],
          reason: `读取仓库清单失败：${reason}`,
          startedAt,
          finishedAt: nowStamp(now()),
        }
        options.emit({ type: 'codehubSyncFinished', summary })
        return summary
      }

      const port = options.port()
      let applied = 0
      let failed = 0
      let abortReason = ''
      /** 输出截断导致「可能不完整」的仓库（design D5 降级信号，随摘要上报） */
      const degraded: string[] = []

      for (const repo of repos) {
        if (abortReason) break // auth 快速终止：后续仓库必然同样失败
        try {
          const result = await port.listMergeRequests(repo.repoId, { limit: settings.pullBatchLimit })
          await options.repo.applySnapshot(repo.repoId, result.records, nowStamp(now()))
          applied += result.records.length
          if (result.degraded) {
            degraded.push(repo.repoId)
            logger.warn(
              `CodeHub 同步（${repo.repoId}）：CLI 输出触到截断上限，本轮快照可能不完整（${result.records.length} 条已入库）`,
            )
          }
          options.emit({ type: 'codehubRepoSynced', repoId: repo.repoId, applied: result.records.length })
        } catch (error) {
          failed += 1
          const kind = error instanceof CodeHubError ? error.kind : 'unknown'
          const reason = error instanceof Error ? error.message : String(error)
          try {
            await options.repo.markSyncError(repo.repoId, reason)
          } catch (markError) {
            logger.warn('记录同步失败状态时出错（快照数据不受影响）', markError)
          }
          options.emit({ type: 'codehubRepoFailed', repoId: repo.repoId, reason, kind })
          logger.warn(`CodeHub 同步失败（${repo.repoId}，${kind}）：${reason}`)
          if (kind === 'auth') abortReason = reason
        }
      }

      const summary: CodeHubSyncSummary = {
        phase: failed === 0 ? 'ok' : 'failed',
        repos: repos.length,
        applied,
        failed,
        degraded,
        reason: abortReason || (failed > 0 ? `${failed} 个仓库同步失败` : ''),
        startedAt,
        finishedAt: nowStamp(now()),
      }
      options.emit({ type: 'codehubSyncFinished', summary })
      return summary
    })()

    inFlight = task
    try {
      const summary = await task
      failedRounds = summary.phase === 'ok' ? 0 : failedRounds + 1
      return summary
    } finally {
      inFlight = null
      // 完成（含失败）后才排下一轮 —— P2 的核心语义；手动轮次也在此统一重排，
      // 与 poller 同款（连点/手动与自动天然去重，定时器先清后排不堆积）
      if (autoOn && !disposed) scheduleNext(nextDelaySec())
    }
  }

  return {
    refresh() {
      // 手动刷新与自动轮询共用同一把 in-flight 锁；退避只推迟自动轮（scheduleNext），
      // 因此手动路径天然不受退避限制，无需再带 manual 标记
      return runRound()
    },

    startAuto() {
      if (disposed || autoOn) return
      const sec = options.settings().pollIntervalSec
      if (sec <= 0) {
        logger.info('CodeHub 自动同步未开启（间隔为 0，仅手动刷新）')
        return
      }
      autoOn = true
      logger.info(`CodeHub 自动同步已启动（间隔 ${nextDelaySec()}s）`)
      // 首轮立即：用户开启开关应当立刻看到数据
      scheduleNext(0)
    },

    stopAuto() {
      autoOn = false
      timers.clear(timer)
      timer = null
    },

    autoRunning() {
      return autoOn
    },

    backoffSec() {
      return failedRounds > 0 ? SYNC_BACKOFF_STEPS[Math.min(failedRounds - 1, SYNC_BACKOFF_STEPS.length - 1)] : 0
    },

    dispose() {
      disposed = true
      autoOn = false
      timers.clear(timer)
      timer = null
    },
  }
}
