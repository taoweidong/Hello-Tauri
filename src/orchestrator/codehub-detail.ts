/**
 * 单条 MR 详情补拉（design D2 的 `mr view` 语义）——「点详情才补拉」这条业务规则
 * 归编排层，store 只做装配（D8）。
 *
 * 为什么不能在 store 里直接实现：补拉会**起子进程**（真实 CLI 模式下），因此必须
 * 有并发去重 —— 用户在详情面板上来回点同一条 MR 时，不能排队起 N 次进程；同时在飞
 * 的补拉合并为同一个 Promise。这属于「怎么调度」的编排决策，与 welink 侧
 * 「事件增量、规则在 orchestrator」的分层一致。
 *
 * 三条不变量：
 *  * **快照优先**：先读本地库，详情已在就绝不碰端口；
 *  * **失败不阻塞浏览**：补拉失败（CLI 不可用 / 输出不可解析）返回只有列表字段的
 *    原记录，面板走「详情待补拉」占位，不向上抛错；
 *  * **成功即回填**：新详情覆盖写 `detail_json`，下次点开直接命中快照。
 */
import type { CodeHubPort } from '@/infra/codehub'
import type { CodeHubRepository } from '@/infra/db'
import type { CodeHubMrRecord } from '@/types/codehub'
import { logger } from '@/utils/logger'
import { nowStamp } from '@/utils/time'

export interface DetailBackfillOptions {
  repo: Pick<CodeHubRepository, 'getMr' | 'saveMrDetail'>
  /** 端口获取函数：每次调用取最新配置（改完 token 不必重启）；测试注入假端口 */
  port: () => CodeHubPort
  now?: () => Date
}

export interface CodeHubDetailBackfill {
  /** 取单条记录（同 key 并发调用共享同一 Promise；永不 reject） */
  fetch(repoId: string, mrIid: string): Promise<CodeHubMrRecord | null>
  /** 该条是否正在补拉（面板可据此显示补拉中，而不是重复触发） */
  pending(repoId: string, mrIid: string): boolean
  /** 丢弃在飞请求表（store 测试复位用） */
  reset(): void
}

const keyOf = (repoId: string, mrIid: string) => `${repoId}!${mrIid}`

export function createDetailBackfill(options: DetailBackfillOptions): CodeHubDetailBackfill {
  const now = options.now ?? (() => new Date())
  const inFlight = new Map<string, Promise<CodeHubMrRecord | null>>()

  async function run(repoId: string, mrIid: string): Promise<CodeHubMrRecord | null> {
    const record = await options.repo.getMr(repoId, mrIid)
    if (!record || record.detail) return record
    try {
      const detail = await options.port().getMergeRequestDetail(repoId, mrIid)
      await options.repo.saveMrDetail(repoId, mrIid, detail, nowStamp(now()))
      return { summary: record.summary, detail }
    } catch (error) {
      logger.warn(`CodeHub 详情补拉失败（${repoId}!${mrIid}）：${error instanceof Error ? error.message : String(error)}`)
      return record
    } finally {
      inFlight.delete(keyOf(repoId, mrIid))
    }
  }

  return {
    fetch(repoId, mrIid) {
      const key = keyOf(repoId, mrIid)
      const existing = inFlight.get(key)
      if (existing) return existing
      const task = run(repoId, mrIid)
      inFlight.set(key, task)
      return task
    },
    pending(repoId, mrIid) {
      return inFlight.has(keyOf(repoId, mrIid))
    },
    reset() {
      inFlight.clear()
    },
  }
}
