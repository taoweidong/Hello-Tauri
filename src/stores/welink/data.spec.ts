import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ref, shallowRef, type Ref, type ShallowRef } from 'vue'

import type { WelinkRuntime } from '@/orchestrator/runtime'
import { emptySummary } from '@/orchestrator/events'
import type { WelinkRepository } from '@/infra/db'
import type { WelinkJob } from '@/types/welink'
import { createWelinkData, type WelinkDataDeps } from './data'

function job(pk: number, overrides: Partial<WelinkJob> = {}): WelinkJob {
  return { pk, targetId: 'G-1', status: 'ready', holdReason: '', createdAt: '', ...overrides } as WelinkJob
}

interface Harness {
  deps: WelinkDataDeps
  repo: WelinkRepository
  runtime: WelinkRuntime
  pushLog: ReturnType<typeof vi.fn>
  pullNow: ReturnType<typeof vi.fn>
  jobIndex: ShallowRef<Map<number, WelinkJob>>
  convJobs: Ref<WelinkJob[]>
  reviewCount: Ref<number>
}

function makeHarness(): Harness {
  const repo = {
    listJobs: vi.fn(async () => [job(1)]),
    countJobs: vi.fn(async () => 0),
    jobStats: vi.fn(async () => ({ sent: 1 })),
    updateDraft: vi.fn(async () => undefined),
    rateJob: vi.fn(async () => undefined),
    listAgentLogs: vi.fn(async () => []),
    listJobsWithLogs: vi.fn(async () => []),
    countJobsWithLogs: vi.fn(async () => 0),
    clearAgentLogs: vi.fn(async () => 3),
    removeJob: vi.fn(async () => true),
    countHolding: vi.fn(async () => 5),
    listInbox: vi.fn(async () => []),
    countInbox: vi.fn(async () => 0),
    searchMessages: vi.fn(async () => []),
  } as unknown as WelinkRepository
  const runtime = {
    pipeline: { sendNow: vi.fn(async () => true) },
    port: vi.fn(() => ({})),
  } as unknown as WelinkRuntime
  const pushLog = vi.fn()
  const pullNow = vi.fn(async () => emptySummary())
  const jobIndex = shallowRef<Map<number, WelinkJob>>(new Map())
  const convJobs = ref<WelinkJob[]>([job(1)])
  const reviewCount = ref(1)
  const deps: WelinkDataDeps = {
    jobIndex,
    convJobs,
    reviewCount,
    repo: () => repo,
    ensureRuntime: async () => runtime,
    pushLog,
    pullNow,
  }
  return { deps, repo, runtime, pushLog, pullNow, jobIndex, convJobs, reviewCount }
}

describe('data：历史 / 回溯透传与内存视图同步', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('listJobs：结果回填任务索引', async () => {
    const harness = makeHarness()
    const data = createWelinkData(harness.deps)
    const jobs = await data.listJobs({ status: 'sent', limit: 10, offset: 0 } as never)
    expect(jobs).toHaveLength(1)
    expect(harness.jobIndex.value.get(1)).toBeTruthy()
  })

  it('retryJob / editAndSend：都走 pipeline.sendNow（人工动作同样过 Gate）', async () => {
    const harness = makeHarness()
    const data = createWelinkData(harness.deps)
    await expect(data.retryJob(1)).resolves.toBe(true)
    await expect(data.editAndSend(1, '改后的草稿')).resolves.toBe(true)
    expect(harness.repo.updateDraft).toHaveBeenCalledWith(1, '改后的草稿')
    expect(harness.pushLog).toHaveBeenCalledWith('info', expect.stringContaining('job 1'))
    expect(harness.runtime.pipeline.sendNow).toHaveBeenCalledTimes(2)
  })

  it('editAndSend：外发失败时不写成功日志', async () => {
    const harness = makeHarness()
    ;(harness.runtime.pipeline.sendNow as ReturnType<typeof vi.fn>).mockResolvedValue(false)
    const data = createWelinkData(harness.deps)
    await expect(data.editAndSend(1, 'x')).resolves.toBe(false)
    expect(harness.pushLog).not.toHaveBeenCalledWith('info', expect.anything())
  })

  it('rateJob：落库 + 索引同步', async () => {
    const harness = makeHarness()
    harness.jobIndex.value = new Map([[1, job(1)]])
    const data = createWelinkData(harness.deps)
    await data.rateJob(1, 'good' as never)
    expect(harness.repo.rateJob).toHaveBeenCalledWith(1, 'good')
    expect(harness.jobIndex.value.get(1)?.rating).toBe('good')
  })

  it('removeJob：同步三处内存视图（索引 / 右栏 / 待审计数）', async () => {
    const harness = makeHarness()
    harness.jobIndex.value = new Map([[1, job(1, { status: 'ready', holdReason: 'blacklist' })]])
    const data = createWelinkData(harness.deps)
    await expect(data.removeJob(1)).resolves.toBe(true)
    expect(harness.jobIndex.value.has(1)).toBe(false)
    expect(harness.convJobs.value).toHaveLength(0)
    expect(harness.reviewCount.value).toBe(5)
    expect(harness.repo.countHolding).toHaveBeenCalledTimes(1)
  })

  it('removeJob：仓储报不存在 → false 且不动内存', async () => {
    const harness = makeHarness()
    ;(harness.repo.removeJob as ReturnType<typeof vi.fn>).mockResolvedValue(false)
    const data = createWelinkData(harness.deps)
    await expect(data.removeJob(99)).resolves.toBe(false)
    expect(harness.convJobs.value).toHaveLength(1)
  })

  it('clearAgentLogs：留痕删除数量（§10 敏感语料）', async () => {
    const harness = makeHarness()
    const data = createWelinkData(harness.deps)
    await expect(data.clearAgentLogs(1)).resolves.toBe(3)
    expect(harness.pushLog).toHaveBeenCalledWith('warn', expect.stringContaining('3 条'))
  })

  it('jobStats：按当天 0 点到当前小时查询', async () => {
    const harness = makeHarness()
    const data = createWelinkData(harness.deps)
    await data.jobStats()
    const [from, to] = (harness.repo.jobStats as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(from).toContain('00:00:00')
    expect(to).toMatch(/:00:00$/)
  })
})

describe('data：收件箱 / 搜索 / 演示', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('listInbox / countInbox / searchMessages 纯透传', async () => {
    const harness = makeHarness()
    const data = createWelinkData(harness.deps)
    await data.listInbox({ limit: 10, offset: 0 } as never)
    await data.countInbox({} as never)
    await data.searchMessages('关键词')
    expect(harness.repo.listInbox).toHaveBeenCalledTimes(1)
    expect(harness.repo.countInbox).toHaveBeenCalledTimes(1)
    expect(harness.repo.searchMessages).toHaveBeenCalledWith('关键词', undefined, undefined, 100, 0)
  })

  it('playDemoScript：非 mock 端口拒绝（O13 仅 mock 可用）', async () => {
    const harness = makeHarness()
    const data = createWelinkData(harness.deps)
    await expect(data.playDemoScript()).resolves.toBe(false)
    expect(harness.pushLog).toHaveBeenCalledWith('warn', expect.stringContaining('仅 mock'))
    expect(harness.pullNow).not.toHaveBeenCalled()
  })

  it('playDemoScript：mock 端口回放后立即拉一轮', async () => {
    const harness = makeHarness()
    ;(harness.runtime.port as ReturnType<typeof vi.fn>).mockReturnValue({ playScript: vi.fn() })
    const data = createWelinkData(harness.deps)
    await expect(data.playDemoScript()).resolves.toBe(true)
    expect(harness.pullNow).toHaveBeenCalledTimes(1)
  })
})
