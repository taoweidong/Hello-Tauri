/**
 * 启动恢复（设计 §6.3）—— 对应需求里的「自动恢复」。
 *
 * 崩溃/强杀/断电后重开，必须把三件事恢复到「能继续跑」的状态：
 *
 * ```
 * db.migrateAll()（幂等）
 *   → listUnfinishedJobs()
 *      ├ status='sending' 且已有 out 回执 → 补记 sent（崩溃在回执前）
 *      ├ status='sending' 且无回执        → 回落 ready（凭 draft + msg_uid 幂等重发）
 *      └ pending / discussing / ready / failed → 重新入队
 *   → watching 会话逐个 scheduleNext（cursor 从库恢复 → 只拉增量）
 * ```
 *
 * 「failed」也在入队范围内：重试耗尽的任务不该在重启后变成孤儿 —— 但**不能**
 * 直接重投（会无限重试一份注定失败的内容）。这里的处理是：**只回落到 ready
 * 但不自动外发**（交给人工在回复历史里点重发），或者当它已经超过重试上限时
 * 保持 failed 等人工介入。实现上选择后者：`failed` 保留原状，只统计并告知 UI，
 * 因为「自动重试失败任务」正是滥发风险的来源。
 *
 * 迁移与恢复都在 `app.isReady` 之后的异步链里执行（P6：不阻塞首屏）。
 */
import { dbMigrateAll, welink } from '@/infra/db'
import type { WelinkRepository } from '@/infra/db'
import type { WelinkJob, WelinkSettings } from '@/types/welink'
import { logger } from '@/utils/logger'
import type { EventSink } from './events'
import type { Pipeline } from './pipeline'
import type { Poller } from './poller'
import type { SafetyGate } from './safety-gate'
import { nowStamp } from '@/utils/time'

/** 恢复结果（UI 启动 toast 与监控页展示用） */
export interface BootstrapReport {
  /** 本次新应用的迁移版本号 */
  migrations: number[]
  /** 补记为 sent 的 job（崩溃在回执前） */
  recoveredSent: number
  /** 回落到 ready 待重发的 job */
  requeued: number
  /** 重新入队的 job（pending/discussing） */
  enqueued: number
  /** 保留 failed 等人工处理的 job */
  failed: number
  /** 参与调度的监控会话数 */
  watching: number
  /** 恢复过程中的警告（不中断启动，但需要让用户看见） */
  warnings: string[]
}

export interface BootstrapOptions {
  repo?: WelinkRepository
  poller: Poller
  pipeline: Pipeline
  gate: SafetyGate
  settings: () => WelinkSettings
  emit: EventSink
  /** 是否启动调度（enabled=false 时只做数据恢复，不开始轮询） */
  autoStart: boolean
}

export interface Bootstrap {
  /** 执行一次启动恢复（幂等；重复调用只跑一次迁移） */
  run(): Promise<BootstrapReport>
  /** 最近一次恢复报告 */
  lastReport(): BootstrapReport | null
}

export function createBootstrap(options: BootstrapOptions): Bootstrap {
  const repo = options.repo ?? welink()
  let report: BootstrapReport | null = null

  return {
    async run(): Promise<BootstrapReport> {
      const result: BootstrapReport = {
        migrations: [],
        recoveredSent: 0,
        requeued: 0,
        enqueued: 0,
        failed: 0,
        watching: 0,
        warnings: [],
      }

      // —— 1. 迁移（幂等，宿主 _migrations 表跟踪） ——
      try {
        result.migrations = await dbMigrateAll()
        if (result.migrations.length) logger.info(`WeLink：已应用迁移 v${result.migrations.join(', v')}`)
      } catch (error) {
        // 迁移失败不能静默：后续所有查询都会失败，必须让用户看到
        const message = `数据库迁移失败：${error instanceof Error ? error.message : String(error)}`
        result.warnings.push(message)
        logger.error('WeLink：数据库迁移失败', error)
        report = result
        return result
      }

      // —— 2. 未终态任务的三分支恢复（§6.3） ——
      let unfinished: WelinkJob[] = []
      try {
        unfinished = await repo.listUnfinishedJobs()
      } catch (error) {
        const message = `读取未完成任务失败：${error instanceof Error ? error.message : String(error)}`
        result.warnings.push(message)
        logger.error('WeLink：读取未完成任务失败', error)
      }

      const enqueue: number[] = []
      for (const job of unfinished) {
        if (job.status === 'sending') {
          // 崩溃窗口：发出去了但没记上 vs 没发出去。**必须**查回执才能区分，
          // 猜错任一方向都会造成「重复回复」或「该回的没回」。
          try {
            if (await repo.hasOutgoingReceipt(job.pk)) {
              const fixed = await repo.markStatus(job.pk, 'sent', 'sending')
              if (fixed) {
                result.recoveredSent += 1
                options.emit({
                  type: 'jobStatusChanged',
                  jobPk: job.pk,
                  from: 'sending',
                  to: 'sent',
                  reason: '启动恢复：凭回执补记已发送',
                })
                logger.warn(`启动恢复：job ${job.pk} 凭回执补记为 sent（崩溃在回执前）`)
              }
            } else {
              const fixed = await repo.suspendJob(job.pk)
              void fixed
              result.requeued += 1
              enqueue.push(job.pk)
              options.emit({
                type: 'jobStatusChanged',
                jobPk: job.pk,
                from: 'sending',
                to: 'ready',
                reason: '启动恢复：无回执，回落待重发',
              })
            }
          } catch (error) {
            result.warnings.push(`job ${job.pk} 恢复失败：${String(error)}`)
          }
          continue
        }

        if (job.status === 'failed') {
          // failed 不自动重投（重试失败的内容再重投 = 滥发风险），交人工
          result.failed += 1
          continue
        }
        if (job.status === 'ready' && job.holdReason) {
          // 待审任务（manual_mode / blacklist）：保持待审，不进自动外发队列
          continue
        }
        // pending / discussing / ready（无 hold）→ 重新入队
        enqueue.push(job.pk)
        result.enqueued += 1
        if (job.status === 'discussing') {
          // discussing 是「上次 worker 出队后进程挂了」—— 回 pending 让生成段重新接管
          await repo.markStatus(job.pk, 'pending', 'discussing')
        }
      }
      if (enqueue.length) options.pipeline.enqueueMany(enqueue)

      // —— 3. SafetyGate 预热（O5：让 check 保持零 SELECT） ——
      try {
        const hourStart = nowStamp().slice(0, 11) + '00:00'
        const globalCount = await repo.countGlobalSentSince(hourStart)
        options.gate.primeGlobal(globalCount)
        // 会话级：只预热「本轮可能用到」的会话（watching + autoReply），避免 N 次查询
        const watching = await repo.listWatching()
        result.watching = watching.length
        for (const conv of watching) {
          const [hourly, lastSent] = await Promise.all([
            repo.countSentSince(conv.convId, hourStart),
            repo.lastSentAt(conv.convId),
          ])
          options.gate.primeConversation(conv.convId, hourly, lastSent)
        }
        logger.info(`WeLink：安全闸口预热完成（本小时已发 ${globalCount} 条，监控会话 ${watching.length} 个）`)
      } catch (error) {
        result.warnings.push(`安全闸口预热失败：${String(error)}`)
        logger.warn(`WeLink：安全闸口预热失败（配额从 0 起算）：${String(error)}`)
      }

      // —— 4. 启动调度（enabled=false 时只做数据恢复） ——
      if (options.autoStart) {
        options.pipeline.start()
        options.poller.start()
      } else {
        logger.info('WeLink：助手总开关关闭，仅完成数据恢复，未启动轮询与管线')
      }

      report = result
      return result
    },

    lastReport() {
      return report
    },
  }
}
