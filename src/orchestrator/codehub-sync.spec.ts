import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { CodeHubPort } from '@/infra/codehub'
import { CodeHubError } from '@/infra/codehub/port'
import type { CodeHubRepository } from '@/infra/db'
import type { CodeHubRepo, CodeHubSettings } from '@/types/codehub'
import type { CodeHubEvent, CodeHubSyncSummary } from './events'
import {
  createCodeHubSyncer,
  SYNC_BACKOFF_STEPS,
  SYNC_MIN_INTERVAL_SEC,
  codeHubConfigured,
  type CodeHubSyncerOptions,
} from './codehub-sync'

/**
 * CodeHub 同步管线单测（design D5，与 poller.spec 同套路）。
 *
 * 钉住的是管线的**调度语义**：single-flight 去重、失败退避序列、auth 快速终止、
 * 未配置不发调用、事件序列完整 —— 行为错一条，UI 状态条与用户预期就会错一条。
 * 时间完全走注入的假时钟（TimerApi），不依赖 vi.useFakeTimers 的宏任务细节。
 */

// ---------------------------------------------------------------- 假时钟

function fakeTimers() {
  let nowMs = 1_700_000_000_000
  const items: Array<{ id: number; at: number; handler: () => void }> = []
  const delays: number[] = []
  let seq = 0
  return {
    now: () => new Date(nowMs),
    api: {
      set(handler: () => void, delayMs: number) {
        seq += 1
        delays.push(delayMs)
        items.push({ id: seq, at: nowMs + delayMs, handler })
        return seq
      },
      clear(id: unknown) {
        const index = items.findIndex((item) => item.id === id)
        if (index >= 0) items.splice(index, 1)
      },
    },
    /** 推进时钟并按到期顺序执行所有到期回调；每次回调后用宏任务级排空，
     *  保证整条 async 链（本轮同步 + finally 重排）执行完再继续推进 */
    async advance(ms: number) {
      const deadline = nowMs + ms
      for (;;) {
        const next = items.length ? Math.min(...items.map((item) => item.at)) : deadline
        if (next > nowMs) nowMs = Math.min(next, deadline)
        const due = items.filter((item) => item.at <= nowMs).sort((a, b) => a.at - b.at)[0]
        if (!due) {
          if (nowMs < deadline) nowMs = deadline
          return
        }
        items.splice(items.indexOf(due), 1)
        due.handler()
        await new Promise((resolve) => setTimeout(resolve, 0))
      }
    },
    pending: () => items.length,
    delays,
  }
}

// ---------------------------------------------------------------- 假件

function repo(repoId: string, enabled = true): CodeHubRepo {
  return { pk: repoId.length, repoId, name: repoId, enabled, createdAt: '2026-10-01 00:00:00' }
}

function fakeRepo(): CodeHubRepository {
  return {
    listRepos: vi.fn(async () => [repo('demo/a'), repo('demo/b', false), repo('demo/c')]),
    addRepo: vi.fn(),
    setRepoEnabled: vi.fn(),
    removeRepo: vi.fn(),
    applySnapshot: vi.fn(async (_repoId: string, records: unknown[]) => (records as unknown[]).length),
    listMrs: vi.fn(async () => []),
    countMrs: vi.fn(async () => 0),
    getMr: vi.fn(async () => null),
    saveMrDetail: vi.fn(async () => true),
    listSyncStates: vi.fn(async () => []),
    markSyncError: vi.fn(async () => {}),
  } as unknown as CodeHubRepository & {
    listRepos: ReturnType<typeof vi.fn>
    applySnapshot: ReturnType<typeof vi.fn>
    markSyncError: ReturnType<typeof vi.fn>
  }
}

function fakePort(impl: Partial<Parameters<typeof createPortProxy>[0]> = {}) {
  return createPortProxy(impl)
}

function createPortProxy(impl: { list?: () => Promise<unknown>; degraded?: boolean; error?: Error } = {}) {
  return {
    listMergeRequests: vi.fn(async () => {
      if (impl.error) throw impl.error
      return { records: impl.list ? await impl.list() : [], degraded: impl.degraded ?? false }
    }),
    getMergeRequestDetail: vi.fn(),
    verifyConnection: vi.fn(),
  } as unknown as CodeHubPort & { listMergeRequests: ReturnType<typeof vi.fn> }
}

function settings(overrides: Partial<CodeHubSettings> = {}): CodeHubSettings {
  return { source: 'cli', cliPath: 'codehub-cli', token: 't', pollIntervalSec: 60, pullBatchLimit: 200, ...overrides }
}

function collector() {
  const events: CodeHubEvent[] = []
  return { events, sink: (event: CodeHubEvent) => events.push(event) }
}

interface Harness {
  syncer: ReturnType<typeof createCodeHubSyncer>
  repo: ReturnType<typeof fakeRepo>
  port: ReturnType<typeof fakePort>
  events: CodeHubEvent[]
  clock: ReturnType<typeof fakeTimers>
  setPort: (next: ReturnType<typeof fakePort>) => void
  settingsValue: CodeHubSettings
}

function harness(settingsOverrides: Partial<CodeHubSettings> = {}, port?: ReturnType<typeof fakePort>): Harness {
  const clock = fakeTimers()
  const state: { settingsValue: CodeHubSettings; port: ReturnType<typeof fakePort> } = {
    settingsValue: settings(settingsOverrides),
    port: port ?? fakePort(),
  }
  const repo = fakeRepo()
  const { events, sink } = collector()
  const options: CodeHubSyncerOptions = {
    repo,
    port: () => state.port,
    settings: () => state.settingsValue,
    emit: sink,
    timers: clock.api,
    now: clock.now,
  }
  const syncer = createCodeHubSyncer(options)
  return {
    syncer,
    repo,
    port: state.port,
    events,
    clock,
    setPort: (next) => {
      state.port = next
    },
    settingsValue: state.settingsValue,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('codehub-sync —— 配置完备性闸门', () => {
  it('codeHubConfigured：mock 恒就绪；cli 必须路径 + token 齐备', () => {
    expect(codeHubConfigured(settings({ source: 'mock', cliPath: '', token: '' }))).toBe(true)
    expect(codeHubConfigured(settings())).toBe(true)
    expect(codeHubConfigured(settings({ token: ' ' }))).toBe(false)
    expect(codeHubConfigured(settings({ cliPath: '' }))).toBe(false)
  })

  it('未配置：refresh 返回 failed 摘要且不发起任何端口调用（spec 引导态）', async () => {
    const h = harness({ token: '' })
    const summary = await h.syncer.refresh()
    expect(summary.phase).toBe('failed')
    expect(summary.reason).toContain('未配置')
    expect(h.port.listMergeRequests).not.toHaveBeenCalled()
    expect(h.events.map((event) => event.type)).toEqual(['codehubSyncStarted', 'codehubSyncFinished'])
  })
})

describe('codehub-sync —— 一轮同步', () => {
  it('成功轮：只同步启用仓库，快照整批落库，事件序列完整', async () => {
    const h = harness()
    const records = [1, 2] as never[]
    h.port.listMergeRequests.mockResolvedValue({ records, degraded: false })
    const summary = await h.syncer.refresh()

    expect(summary).toMatchObject({ phase: 'ok', repos: 2, applied: 4, failed: 0 })
    // 禁用仓库 demo/b 不参与
    expect((h.port.listMergeRequests.mock.calls.map((call) => call[0]) as string[]).sort()).toEqual([
      'demo/a',
      'demo/c',
    ])
    expect(h.repo.applySnapshot).toHaveBeenCalledTimes(2)
    const types = h.events.map((event) => event.type)
    expect(types).toEqual(['codehubSyncStarted', 'codehubRepoSynced', 'codehubRepoSynced', 'codehubSyncFinished'])
  })

  it('单仓库失败不中断整轮：其余照常，失败仓库记 markSyncError', async () => {
    const h = harness()
    h.port.listMergeRequests.mockImplementation(async (repoId: string) => {
      if (repoId === 'demo/a') throw new CodeHubError('命令超时', 'transport')
      return { records: [1] as never[], degraded: false }
    })
    const summary = await h.syncer.refresh()

    expect(summary).toMatchObject({ phase: 'failed', repos: 2, applied: 1, failed: 1 })
    expect(h.repo.markSyncError).toHaveBeenCalledWith('demo/a', '命令超时')
    const failedEvent = h.events.find((event) => event.type === 'codehubRepoFailed') as Extract<
      CodeHubEvent,
      { type: 'codehubRepoFailed' }
    >
    expect(failedEvent).toMatchObject({ repoId: 'demo/a', kind: 'transport' })
  })

  it('截断降级进摘要：degraded 仓库列表上报，phase 仍按失败计数判定（告警不静默）', async () => {
    const h = harness({}, fakePort({ list: () => Promise.resolve([1] as never[]), degraded: true }))
    const summary = await h.syncer.refresh()

    expect(summary).toMatchObject({ phase: 'ok', applied: 2, degraded: ['demo/a', 'demo/c'] })
    expect(h.repo.applySnapshot).toHaveBeenCalledTimes(2)
  })

  it('正常轮不带降级：degraded 为空数组', async () => {
    const h = harness()
    const summary = await h.syncer.refresh()
    expect(summary.degraded).toEqual([])
  })

  it('auth 失败快速终止本轮：剩余仓库不再发起调用', async () => {
    const h = harness()
    h.port.listMergeRequests.mockRejectedValue(new CodeHubError('token 已失效', 'auth'))
    const summary = await h.syncer.refresh()

    expect(summary.phase).toBe('failed')
    expect(summary.reason).toContain('token')
    // 三个启用仓库只有第一个被调用（demo/b 禁用本来就不参与）
    expect(h.port.listMergeRequests).toHaveBeenCalledTimes(1)
    expect(h.repo.markSyncError).toHaveBeenCalledTimes(1)
  })

  it('读取仓库清单失败：整轮 failed 但永不 reject', async () => {
    const h = harness()
    ;(h.repo.listRepos as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('db boom'))
    const summary = await h.syncer.refresh()
    expect(summary).toMatchObject({ phase: 'failed', repos: 0 })
    expect(summary.reason).toContain('db boom')
    expect(h.port.listMergeRequests).not.toHaveBeenCalled()
  })

  it('single-flight：并发 refresh 共用同一轮（端口只被调用一次）', async () => {
    const h = harness()
    const [first, second] = await Promise.all([h.syncer.refresh(), h.syncer.refresh()])
    expect(first).toBe(second)
    expect(h.port.listMergeRequests).toHaveBeenCalledTimes(2) // demo/a + demo/c
  })
})

describe('codehub-sync —— 自动轮询与退避', () => {
  it('pollIntervalSec=0：startAuto 不启动（仅手动刷新）', () => {
    const h = harness({ pollIntervalSec: 0 })
    h.syncer.startAuto()
    expect(h.syncer.autoRunning()).toBe(false)
    expect(h.clock.pending()).toBe(0)
  })

  it('间隔钳制：配置 30s 也按 SYNC_MIN_INTERVAL_SEC=60 排下一轮', async () => {
    const h = harness({ pollIntervalSec: 30 })
    h.syncer.startAuto()
    await h.clock.advance(0) // 首轮立即
    expect(h.syncer.autoRunning()).toBe(true)
    await h.clock.advance(SYNC_MIN_INTERVAL_SEC * 1000 - 1)
    expect(h.port.listMergeRequests).toHaveBeenCalledTimes(2) // 第二轮尚未到
    await h.clock.advance(1)
    expect(h.port.listMergeRequests).toHaveBeenCalledTimes(4) // 第二轮到了（2 仓库 × 2 轮）
  })

  it('失败退避：连续失败按 SYNC_BACKOFF_STEPS 推迟，成功清零', async () => {
    const h = harness({ pollIntervalSec: 60 })
    h.port.listMergeRequests.mockRejectedValue(new CodeHubError('超时', 'transport'))
    h.syncer.startAuto()
    await h.clock.advance(0) // 第 1 轮（失败）
    expect(h.syncer.backoffSec()).toBe(SYNC_BACKOFF_STEPS[0])
    expect(h.clock.delays.at(-1)).toBe(SYNC_BACKOFF_STEPS[0] * 1000)

    await h.clock.advance(SYNC_BACKOFF_STEPS[0]! * 1000) // 第 2 轮（失败）
    expect(h.syncer.backoffSec()).toBe(SYNC_BACKOFF_STEPS[1])
    expect(h.clock.delays.at(-1)).toBe(SYNC_BACKOFF_STEPS[1]! * 1000)

    h.setPort(fakePort()) // 换健康端口
    await h.clock.advance(SYNC_BACKOFF_STEPS[1]! * 1000) // 第 3 轮（成功）
    expect(h.syncer.backoffSec()).toBe(0)
    expect(h.clock.delays.at(-1)).toBe(60 * 1000)
  })

  it('手动刷新成功立即清零退避', async () => {
    const h = harness()
    h.port.listMergeRequests.mockRejectedValueOnce(new CodeHubError('超时', 'transport'))
    await h.syncer.refresh()
    expect(h.syncer.backoffSec()).toBeGreaterThan(0)
    h.setPort(fakePort())
    await h.syncer.refresh()
    expect(h.syncer.backoffSec()).toBe(0)
  })

  it('stopAuto / dispose：清掉待执行的定时器，dispose 后 startAuto 无效', async () => {
    const h = harness()
    h.syncer.startAuto()
    await h.clock.advance(0)
    expect(h.clock.pending()).toBe(1)
    h.syncer.stopAuto()
    expect(h.clock.pending()).toBe(0)

    h.syncer.startAuto()
    expect(h.syncer.autoRunning()).toBe(true)
    h.syncer.dispose()
    h.syncer.startAuto()
    expect(h.syncer.autoRunning()).toBe(false)
    expect(h.clock.pending()).toBe(0)
  })
})

describe('codehub-sync —— 摘要与事件形状', () => {
  it('finished 事件携带 startedAt/finishedAt 与计数（toast 数据源）', async () => {
    const h = harness()
    const summary: CodeHubSyncSummary = await h.syncer.refresh()
    const finished = h.events.at(-1) as Extract<CodeHubEvent, { type: 'codehubSyncFinished' }>
    expect(finished.summary).toEqual(summary)
    expect(summary.startedAt).toBeTruthy()
    expect(summary.finishedAt).toBeTruthy()
  })
})
