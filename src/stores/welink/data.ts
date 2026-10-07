/**
 * 数据访问层（quality-hardening-2026-10 D1）—— 历史回溯 / 收件箱 / 搜索的仓储
 * 透传，以及「人工动作」（重发 / 编辑发送 / 评价 / 清理 / 删除）与演示剧本。
 *
 * 透传的意义不是转发本身，而是「读取后同步内存视图」的收口点：jobIndex /
 * convJobs / reviewCount 的一致性只在这一处维护（见 removeJob 的三处同步）。
 */
import type { Ref, ShallowRef } from 'vue'

import { nowStamp, today } from '@/utils/time'
import type { WelinkRuntime } from '@/orchestrator/runtime'
import type { PollSummary } from '@/orchestrator/events'
import type { InboxQuery, JobQuery, WelinkRepository } from '@/infra/db'
import type { JobRating, WelinkAgentLog, WelinkJob, WelinkSettings } from '@/types/welink'
import { createAgentProbe } from '@/infra/agent'
import { createRagProbe } from '@/infra/rag'

export interface WelinkDataDeps {
  jobIndex: ShallowRef<Map<number, WelinkJob>>
  convJobs: Ref<WelinkJob[]>
  reviewCount: Ref<number>
  /** 存储网关注入点（orchestrator/welink-storage） */
  repo: () => WelinkRepository
  ensureRuntime: () => Promise<WelinkRuntime>
  pushLog: (level: 'info' | 'warn' | 'error', text: string) => void
  pullNow: () => Promise<PollSummary>
}

export interface WelinkData {
  listJobs(query: Omit<JobQuery, 'limit' | 'offset'> & { limit: number; offset: number }): Promise<WelinkJob[]>
  countJobs(query: Omit<JobQuery, 'limit' | 'offset'>): Promise<number>
  jobStats(): Promise<Awaited<ReturnType<WelinkRepository['jobStats']>>>
  retryJob(jobPk: number): Promise<boolean>
  editAndSend(jobPk: number, text: string): Promise<boolean>
  rateJob(jobPk: number, rating: JobRating | null): Promise<void>
  listAgentLogs(jobPk: number): Promise<WelinkAgentLog[]>
  listJobsWithLogs(
    limit?: number,
    offset?: number,
    onlyDownRated?: boolean,
  ): ReturnType<WelinkRepository['listJobsWithLogs']>
  countJobsWithLogs(onlyDownRated?: boolean): ReturnType<WelinkRepository['countJobsWithLogs']>
  clearAgentLogs(jobPk: number): Promise<number>
  removeJob(jobPk: number): Promise<boolean>
  listInbox(query: InboxQuery): ReturnType<WelinkRepository['listInbox']>
  countInbox(query: Omit<InboxQuery, 'limit' | 'offset'>): ReturnType<WelinkRepository['countInbox']>
  searchMessages(
    keyword: string,
    from?: string,
    to?: string,
    limit?: number,
    offset?: number,
  ): ReturnType<WelinkRepository['searchMessages']>
  playDemoScript(): Promise<boolean>
  probeAgent(agent: WelinkSettings['agent']): Promise<string>
  probeRag(rag: WelinkSettings['rag']): Promise<{ latencyMs: number; preview: string }>
}

export function createWelinkData(deps: WelinkDataDeps): WelinkData {
  const { jobIndex, convJobs, reviewCount, repo, ensureRuntime, pushLog, pullNow } = deps

  async function listJobs(query: Omit<JobQuery, 'limit' | 'offset'> & { limit: number; offset: number }) {
    const jobs = await repo().listJobs(query)
    for (const job of jobs) jobIndex.value.set(job.pk, job)
    jobIndex.value = new Map(jobIndex.value)
    return jobs
  }

  async function countJobs(query: Omit<JobQuery, 'limit' | 'offset'>) {
    return repo().countJobs(query)
  }

  async function jobStats() {
    const stamp = today()
    return repo().jobStats(`${stamp} 00:00:00`, `${stamp} ${nowStamp().slice(11, 13)}:00:00`)
  }

  /** 人工重发（失败/被拦任务）：回到 ready 入队，重发同样过 Gate */
  async function retryJob(jobPk: number): Promise<boolean> {
    const active = await ensureRuntime()
    return active.pipeline.sendNow(jobPk)
  }

  /** 编辑并发送（manual）：先落草稿再走外发（要点3） */
  async function editAndSend(jobPk: number, text: string): Promise<boolean> {
    await repo().updateDraft(jobPk, text)
    const active = await ensureRuntime()
    const ok = await active.pipeline.sendNow(jobPk)
    if (ok) pushLog('info', `已提交人工发送（job ${jobPk}）`)
    return ok
  }

  /** O10 评价 */
  async function rateJob(jobPk: number, rating: JobRating | null) {
    await repo().rateJob(jobPk, rating)
    const job = jobIndex.value.get(jobPk)
    if (job) {
      job.rating = rating
      jobIndex.value = new Map(jobIndex.value)
    }
  }

  async function listAgentLogs(jobPk: number): Promise<WelinkAgentLog[]> {
    return repo().listAgentLogs(jobPk)
  }

  async function listJobsWithLogs(limit = 50, offset = 0, onlyDownRated = false) {
    return repo().listJobsWithLogs(limit, offset, onlyDownRated)
  }

  async function countJobsWithLogs(onlyDownRated = false) {
    return repo().countJobsWithLogs(onlyDownRated)
  }

  /** 清理回溯记录（§10：语料含敏感对话） */
  async function clearAgentLogs(jobPk: number): Promise<number> {
    const removed = await repo().clearAgentLogs(jobPk)
    pushLog('warn', `已清理 job ${jobPk} 的 ${removed} 条回溯记录`)
    return removed
  }

  /**
   * 删除单条任务记录（§11.3 行操作）。
   *
   * 删除后必须同步三处内存视图，否则界面会显示一条点不开的幽灵行：任务索引、
   * 当前会话待办列表、待审计计数。触发消息与会话**不动** —— 这是仓储的语义边界。
   */
  async function removeJob(jobPk: number): Promise<boolean> {
    const removed = await repo().removeJob(jobPk)
    if (!removed) return false
    const job = jobIndex.value.get(jobPk)
    const wasHolding = Boolean(job && job.status === 'ready' && job.holdReason)
    jobIndex.value.delete(jobPk)
    jobIndex.value = new Map(jobIndex.value)
    convJobs.value = convJobs.value.filter((item) => item.pk !== jobPk)
    if (wasHolding) reviewCount.value = await repo().countHolding()
    return true
  }

  // ---------------- 收件箱 / 搜索（R2 / O12） ----------------

  async function listInbox(query: InboxQuery) {
    return repo().listInbox(query)
  }

  async function countInbox(query: Omit<InboxQuery, 'limit' | 'offset'>) {
    return repo().countInbox(query)
  }

  async function searchMessages(keyword: string, from?: string, to?: string, limit = 100, offset = 0) {
    return repo().searchMessages(keyword, from, to, limit, offset)
  }

  // ---------------- 演示剧本（O13） ----------------

  async function playDemoScript(): Promise<boolean> {
    const active = await ensureRuntime()
    // mock 端口额外带剧本能力；真实 CLI 端口没有 → 按钮置灰（O13 仅 mock 可用）
    const handle = active.port() as unknown as Partial<{ playScript: () => void }>
    if (typeof handle.playScript !== 'function') {
      pushLog('warn', '当前数据源不支持演示剧本（仅 mock 可用）')
      return false
    }
    handle.playScript()
    pushLog('info', '演示剧本已回放：等待轮询拉取「新人群聊 @我 → 私聊追问 → 对方回应」')
    // 立刻拉一轮，让评审看到完整链路（拉取 → 生成 → Gate → 外发）
    await pullNow()
    return true
  }

  /**
   * Agent 连通性探测（设置页「测试连接」）。
   *
   * 走 `createAgentProbe`（评审 A-1）：每次调用创建独立探针实例 —— 共享运行期
   * 同一份环境兜底（浏览器强制 mock，探测结论与真实运行链路一致），但不命中
   * 全局缓存、不挂管线 onCall 录音钩子，探测请求不污染 R4 留痕语料。
   * UI 经此方法使用，不直触 infra（quality-hardening-2026-10 V1 治理）。
   */
  async function probeAgent(agent: WelinkSettings['agent']): Promise<string> {
    const probe = createAgentProbe({ ...agent, timeoutMs: Math.min(agent.timeoutMs, 15_000) })
    return probe.complete('连通性测试：请只回复「ok」两个字符。')
  }

  /**
   * RAG 检索探测（设置页「测试检索」）。
   *
   * 与 probeAgent 同款立场：走 `createRagProbe` 独立实例——共享运行期环境兜底
   * （浏览器强制 mock，探测结论与真实链路一致），不进全局缓存；检索探测不发
   * 生成调用，不产生任何留痕。超时压到 15s（与 probeAgent 同款），避免测试
   * 按钮在慢服务上挂满配置超时。
   */
  async function probeRag(rag: WelinkSettings['rag']): Promise<{ latencyMs: number; preview: string }> {
    const started = Date.now()
    const chunks = await createRagProbe({ ...rag, timeoutMs: Math.min(rag.timeoutMs, 15_000) }).retrieve({
      query: '连通性测试：VPN 连不上怎么处理',
      topK: rag.topK,
    })
    return {
      latencyMs: Date.now() - started,
      preview: chunks.length
        ? chunks
            .map((chunk) => `[${chunk.score.toFixed(2)}] ${chunk.content}`)
            .join(' / ')
            .slice(0, 120)
        : '（服务可达，本次零命中）',
    }
  }

  return {
    listJobs,
    countJobs,
    jobStats,
    retryJob,
    editAndSend,
    rateJob,
    listAgentLogs,
    listJobsWithLogs,
    countJobsWithLogs,
    clearAgentLogs,
    removeJob,
    listInbox,
    countInbox,
    searchMessages,
    playDemoScript,
    probeAgent,
    probeRag,
  }
}
