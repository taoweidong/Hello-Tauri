import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

import { resetSecretsForTest } from '@/utils/logger'
import type { CodeHubMrRecord } from '@/types/codehub'

/**
 * CodeHub 检视 store 单测（personal-workbench）。
 *
 * 钉的是装配与状态聚合语义：初始化幂等、事件驱动 syncing/lastSummary、
 * 详情单条补拉回填、未配置验证不发调用、自动同步开关跟随配置 ——
 * 编排语义（退避/auth 终止）在 codehub-sync.spec，快照语义在仓储 spec，这里不重复。
 */

const fakes = vi.hoisted(() => {
  const repoFake = {
    listRepos: vi.fn(async () => [{ pk: 1, repoId: 'demo/x', name: 'x', enabled: true, createdAt: 'c' }]),
    addRepo: vi.fn(async (repoId: string, name: string) => ({ pk: 2, repoId, name, enabled: true, createdAt: 'c' })),
    setRepoEnabled: vi.fn(async () => true),
    removeRepo: vi.fn(async () => true),
    applySnapshot: vi.fn(async () => 0),
    listMrs: vi.fn(async () => []),
    countMrs: vi.fn(async () => 0),
    getMr: vi.fn(async (): Promise<CodeHubMrRecord | null> => null),
    saveMrDetail: vi.fn(async () => true),
    listSyncStates: vi.fn(async () => [{ repoId: 'demo/x', lastSyncedAt: 't', lastError: null }]),
    markSyncError: vi.fn(async () => {}),
  }
  const portFake = {
    listMergeRequests: vi.fn(async () => []),
    getMergeRequestDetail: vi.fn(async () => ({ description: '补拉详情', comments: [] })),
    verifyConnection: vi.fn(async () => ({ ok: true, detail: '可用' })),
  }
  const syncerFake = {
    refresh: vi.fn(async () => ({
      phase: 'ok' as const,
      repos: 1,
      applied: 3,
      failed: 0,
      reason: '',
      startedAt: 's',
      finishedAt: 'f',
    })),
    startAuto: vi.fn(),
    stopAuto: vi.fn(),
    autoRunning: vi.fn(() => true),
    backoffSec: vi.fn(() => 0),
    dispose: vi.fn(),
  }
  let emit: ((event: unknown) => void) | null = null
  return {
    repoFake,
    portFake,
    syncerFake,
    setEmit: (fn: (event: unknown) => void) => {
      emit = fn
    },
    fire: (event: unknown) => emit?.(event),
    appState: null as unknown as { codeHub: Record<string, unknown> },
  }
})

vi.mock('@/stores/app', async () => {
  // reactive 状态放进 hoisted 的 fakes：测试通过代理赋值，store 的 computed 会重算
  const { reactive } = await import('vue')
  fakes.appState = reactive<{ codeHub: Record<string, unknown> }>({
    codeHub: { source: 'cli', cliPath: 'codehub-cli', token: 'tok-12345678', pollIntervalSec: 0, pullBatchLimit: 200 },
  })
  return {
    useAppStore: () => ({ settings: fakes.appState }),
  }
})
vi.mock('@/infra/db', () => ({
  dbMigrateAll: vi.fn(async () => []),
  codehub: () => fakes.repoFake,
  setCodehubRepository: vi.fn(),
}))
vi.mock('@/infra/codehub', () => ({
  codeHubPort: vi.fn(() => fakes.portFake),
}))
vi.mock('@/orchestrator/codehub-sync', () => ({
  createCodeHubSyncer: vi.fn((options: { emit: (event: unknown) => void }) => {
    fakes.setEmit(options.emit)
    return fakes.syncerFake
  }),
  codeHubConfigured: (s: { source: string; cliPath: string; token: string }) =>
    s.source !== 'cli' || (s.cliPath.trim() !== '' && s.token.trim() !== ''),
  SYNC_MIN_INTERVAL_SEC: 60,
}))

import { useCodehubStore } from './codehub'

beforeEach(() => {
  vi.clearAllMocks()
  resetSecretsForTest()
  setActivePinia(createPinia())
  setAppSettings({
    source: 'cli',
    cliPath: 'codehub-cli',
    token: 'tok-12345678',
    pollIntervalSec: 0,
    pullBatchLimit: 200,
  })
  const store = useCodehubStore()
  store._resetForTest()
})

/** 替换 app 设置（写进 mock 工厂注册的 reactive 状态，store 的 computed 会随它重算） */
function setAppSettings(codeHub: Record<string, unknown>) {
  fakes.appState.codeHub = codeHub
}

describe('codehub store —— 初始化与装配', () => {
  it('init：迁移 + 装载清单与同步状态；进程内幂等（第二次不再迁移）', async () => {
    const store = useCodehubStore()
    await expect(store.init()).resolves.toBe(true)
    expect(store.repos).toHaveLength(1)
    expect(store.syncStates['demo/x']).toMatchObject({ lastSyncedAt: 't' })
    await store.init()
    const { dbMigrateAll } = await import('@/infra/db')
    expect(dbMigrateAll).toHaveBeenCalledTimes(1)
  })

  it('configured：cli + 路径 + token 齐备为 true；token 清空即 false（引导态口径）', async () => {
    const store = useCodehubStore()
    await store.init()
    expect(store.configured).toBe(true)
    setAppSettings({ source: 'cli', cliPath: 'codehub-cli', token: '', pollIntervalSec: 0, pullBatchLimit: 200 })
    expect(store.configured).toBe(false)
    setAppSettings({ source: 'mock', cliPath: '', token: '', pollIntervalSec: 0, pullBatchLimit: 200 })
    expect(store.configured).toBe(true)
  })

  it('init 应用级装配：间隔 >0 且配置齐备 → 自动同步随装载启动', async () => {
    setAppSettings({
      source: 'cli',
      cliPath: 'codehub-cli',
      token: 'tok-12345678',
      pollIntervalSec: 120,
      pullBatchLimit: 200,
    })
    const store = useCodehubStore()
    await store.init()
    expect(fakes.syncerFake.startAuto).toHaveBeenCalledTimes(1)
    expect(store.autoOn).toBe(true)
    expect(store.effectiveIntervalSec).toBe(120)
  })

  it('init：间隔为 0 不起轮询（手动优先的默认态）', async () => {
    const store = useCodehubStore()
    await store.init()
    expect(fakes.syncerFake.startAuto).not.toHaveBeenCalled()
    expect(store.autoOn).toBe(false)
  })

  it('init 并发去重：两处入口同时进来只迁移一次', async () => {
    const store = useCodehubStore()
    const [a, b] = await Promise.all([store.init(), store.init()])
    expect(a).toBe(true)
    expect(b).toBe(true)
    const { dbMigrateAll } = await import('@/infra/db')
    expect(dbMigrateAll).toHaveBeenCalledTimes(1)
  })

  it('init 失败不缓存结果：修好后可再试（检视页「重试」依赖这条语义）', async () => {
    const { dbMigrateAll } = await import('@/infra/db')
    vi.mocked(dbMigrateAll).mockRejectedValueOnce(new Error('迁移失败'))
    const store = useCodehubStore()
    await expect(store.init()).resolves.toBe(false)
    await expect(store.init()).resolves.toBe(true)
    expect(dbMigrateAll).toHaveBeenCalledTimes(2)
  })

  it('applyAutoSettings：保存配置后即时重评估（>0 起 / 归零停），间隔低于下限钳到 60s', async () => {
    const store = useCodehubStore()
    await store.init()

    setAppSettings({
      source: 'cli',
      cliPath: 'codehub-cli',
      token: 'tok-12345678',
      pollIntervalSec: 30,
      pullBatchLimit: 200,
    })
    store.applyAutoSettings()
    expect(fakes.syncerFake.startAuto).toHaveBeenCalledTimes(1)
    expect(store.autoOn).toBe(true)
    expect(store.effectiveIntervalSec).toBe(60)

    setAppSettings({
      source: 'cli',
      cliPath: 'codehub-cli',
      token: 'tok-12345678',
      pollIntervalSec: 0,
      pullBatchLimit: 200,
    })
    store.applyAutoSettings()
    expect(fakes.syncerFake.stopAuto).toHaveBeenCalledTimes(1)
    expect(store.autoOn).toBe(false)
  })
})

describe('codehub store —— 同步动作与事件', () => {
  it('refresh：委托 syncer 并回读同步状态', async () => {
    const store = useCodehubStore()
    await store.init()
    const summary = await store.refresh()
    expect(summary).toMatchObject({ phase: 'ok', applied: 3 })
    expect(fakes.syncerFake.refresh).toHaveBeenCalledTimes(1)
    expect(fakes.repoFake.listSyncStates).toHaveBeenCalled()
  })

  it('事件驱动：started 置 syncing，finished 落 lastSummary 并复位', async () => {
    const store = useCodehubStore()
    await store.init()
    await store.refresh() // 先创建 syncer（惰性装配），emit 回调才已注册
    expect(store.syncing).toBe(false)
    fakes.fire({ type: 'codehubSyncStarted' })
    expect(store.syncing).toBe(true)
    fakes.fire({
      type: 'codehubSyncFinished',
      summary: { phase: 'failed', repos: 1, applied: 0, failed: 1, reason: 'boom', startedAt: 's', finishedAt: 'f' },
    })
    expect(store.syncing).toBe(false)
    expect(store.lastSummary).toMatchObject({ phase: 'failed', reason: 'boom' })
  })

  it('自动同步：startAuto/stopAuto 透传；间隔归零时 applyAutoSettings 自动停', async () => {
    const store = useCodehubStore()
    await store.init()
    setAppSettings({
      source: 'cli',
      cliPath: 'codehub-cli',
      token: 't-1234',
      pollIntervalSec: 120,
      pullBatchLimit: 200,
    })
    store.startAuto()
    expect(fakes.syncerFake.startAuto).toHaveBeenCalled()
    expect(store.autoOn).toBe(true)

    setAppSettings({ source: 'cli', cliPath: 'codehub-cli', token: 't-1234', pollIntervalSec: 0, pullBatchLimit: 200 })
    store.applyAutoSettings()
    expect(fakes.syncerFake.stopAuto).toHaveBeenCalled()
    expect(store.autoOn).toBe(false)
  })
})

describe('codehub store —— 仓库注册与快照查询', () => {
  it('addRepo：空标识抛错；正常注册后重载清单', async () => {
    const store = useCodehubStore()
    await store.init()
    await expect(store.addRepo('  ', '')).rejects.toThrow('仓库标识不能为空')
    await store.addRepo('demo/y', '')
    expect(fakes.repoFake.addRepo).toHaveBeenCalledWith('demo/y', 'demo/y')
    expect(fakes.repoFake.listRepos).toHaveBeenCalledTimes(2)
  })

  it('removeRepo：仓储返回 false 时抛错（仓库不存在）', async () => {
    const store = useCodehubStore()
    await store.init()
    fakes.repoFake.removeRepo.mockResolvedValueOnce(false)
    await expect(store.removeRepo(99)).rejects.toThrow('仓库不存在或已被删除')
  })

  it('getMr：详情缺失时单条补拉并回填快照；补拉失败退回原记录', async () => {
    const store = useCodehubStore()
    await store.init()
    const bare: CodeHubMrRecord = {
      summary: {
        repoId: 'demo/x',
        mrIid: '101',
        title: 'T',
        state: 'open',
        author: 'a',
        sourceBranch: 's',
        targetBranch: 't',
        updatedAt: 'u',
        webUrl: '',
        review: { reviewers: ['bob'], approvals: 1, unresolved: 2, lastActivityAt: 'l' },
      },
      detail: null,
    }
    fakes.repoFake.getMr.mockResolvedValueOnce(bare)
    const filled = await store.getMr('demo/x', '101')
    expect(filled).toMatchObject({ detail: { description: '补拉详情' } })
    expect(fakes.portFake.getMergeRequestDetail).toHaveBeenCalledWith('demo/x', '101')
    expect(fakes.repoFake.saveMrDetail).toHaveBeenCalledWith('demo/x', '101', expect.anything(), expect.anything())

    fakes.repoFake.getMr.mockResolvedValueOnce(bare)
    fakes.portFake.getMergeRequestDetail.mockRejectedValueOnce(new Error('CLI 不可用'))
    await expect(store.getMr('demo/x', '101')).resolves.toBe(bare)
  })

  it('listMrs/countMrs：查询直通仓储（筛选分页归视图持有）', async () => {
    const store = useCodehubStore()
    await store.init()
    await store.listMrs({ repoId: 'demo/x', limit: 20, offset: 0 })
    await store.countMrs({ repoId: 'demo/x' })
    expect(fakes.repoFake.listMrs).toHaveBeenCalledWith({ repoId: 'demo/x', limit: 20, offset: 0 })
    expect(fakes.repoFake.countMrs).toHaveBeenCalledWith({ repoId: 'demo/x' })
  })
})

describe('codehub store —— 连通验证', () => {
  it('未配置齐备：直接返回引导性失败，不发任何调用', async () => {
    const store = useCodehubStore()
    await store.init()
    const result = await store.verifyConnection({ token: '' })
    expect(result).toMatchObject({ ok: false })
    expect(result.detail).toContain('未配置')
    expect(fakes.portFake.verifyConnection).not.toHaveBeenCalled()
  })

  it('配置齐备：用合并后的设置验证（表单草稿可先于保存验证）', async () => {
    const store = useCodehubStore()
    await store.init()
    const result = await store.verifyConnection({ cliPath: 'D:\\tools\\codehub-cli.exe', token: 'draft-token' })
    expect(result).toEqual({ ok: true, detail: '可用' })
  })
})
