import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { reactive } from 'vue'

import type { CodeHubMrRecord, CodeHubMrState, CodeHubRepo, CodeHubSyncState } from '@/types/codehub'
import type { CodeHubSyncSummary } from '@/orchestrator/events'
import CodehubReviewView from './CodehubReviewView.vue'

/**
 * 检视页组件测试（personal-workbench）。
 *
 * 这里测的是**页面级契约**——store 测状态聚合，端口测取数，只有挂载真实视图才能
 * 钉住这几条容易悄悄回退的行为：
 *  1. 未配置时整页只出引导卡，一个调用都不发（spec 引导态）；
 *  2. 装载失败必须是「可重试的失败态」，而不是永远停在「装载中」；
 *  3. 列表浏览只读快照：切筛选/切仓库只查库，唯一的子进程出口是缺详情那条的补拉；
 *  4. 删掉正在筛选的仓库后，筛选与详情必须一起收口，且无条件刷新；
 *  5. 同步开关写库失败要回落真实清单（复选框不能停在用户刚点出来的假状态）。
 *
 * store 换成 reactive 的假件（不是真 Pinia）：视图只认接口形状，测试要的是可控状态。
 */

let testStore: Record<string, unknown>

vi.mock('@/stores/codehub', () => ({
  useCodehubStore: () => testStore,
}))
vi.mock('@/stores/app', () => ({
  useAppStore: () => ({ info: { platform: 'web' } }),
}))
vi.mock('vue-router', () => ({
  useRouter: () => ({ push: vi.fn() }),
}))

interface Data {
  rows: CodeHubMrRecord[]
}

function repo(pk: number, repoId: string, enabled = true): CodeHubRepo {
  return { pk, repoId, name: repoId, enabled, createdAt: '2026-10-01 00:00:00' }
}

function record(repoId: string, mrIid: string, state: CodeHubMrState, withDetail = true): CodeHubMrRecord {
  return {
    summary: {
      repoId,
      mrIid,
      title: `${repoId} 的 ${state} MR`,
      state,
      author: 'someone',
      sourceBranch: 'feat',
      targetBranch: 'main',
      updatedAt: '2026-10-02 10:00:00',
      webUrl: '',
      review: { reviewers: [], approvals: 0, unresolved: 0, lastActivityAt: '' },
    },
    detail: withDetail ? { description: '正文', comments: [] } : null,
  }
}

function summary(overrides: Partial<CodeHubSyncSummary> = {}): CodeHubSyncSummary {
  return {
    phase: 'ok',
    repos: 1,
    applied: 0,
    failed: 0,
    degraded: [],
    reason: '',
    startedAt: '2026-10-03 09:00:00',
    finishedAt: '2026-10-03 09:00:01',
    ...overrides,
  }
}

function makeStore(data: Data, overrides: Record<string, unknown> = {}) {
  return reactive({
    repos: [] as CodeHubRepo[],
    syncStates: {} as Record<string, CodeHubSyncState>,
    syncing: false,
    lastSummary: null as CodeHubSyncSummary | null,
    autoOn: false,
    backoffSec: 0,
    configured: true,
    source: 'mock',
    effectiveIntervalSec: 60,
    init: vi.fn(async () => true),
    listMrs: vi.fn(async () => data.rows),
    countMrs: vi.fn(async () => data.rows.length),
    getMr: vi.fn(async (_repoId: string, mrIid: string) => data.rows.find((r) => r.summary.mrIid === mrIid) ?? null),
    refresh: vi.fn(async () => summary()),
    addRepo: vi.fn(async () => {}),
    setRepoEnabled: vi.fn(async () => {}),
    removeRepo: vi.fn(async () => {}),
    loadRepos: vi.fn(async () => {}),
    loadSyncStates: vi.fn(async () => {}),
    ...overrides,
  })
}

async function mountView(rows: CodeHubMrRecord[] = [], build?: (data: Data) => Record<string, unknown>) {
  const data: Data = { rows }
  testStore = makeStore(data, build?.(data))
  const wrapper = mount(CodehubReviewView)
  await flushPromises()
  return wrapper
}

const asMock = (name: string) => testStore[name] as ReturnType<typeof vi.fn>

describe('CodehubReviewView', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('未配置：整页只出引导卡，不渲染数据区也不发任何调用', async () => {
    const wrapper = await mountView([], () => ({ configured: false }))
    expect(wrapper.get('[aria-label="未配置引导"]').text()).toContain('尚未配置 codehub-cli')
    expect(wrapper.find('.toolbar').exists()).toBe(false)
    expect(wrapper.find('.repos').exists()).toBe(false)
    expect(asMock('refresh')).not.toHaveBeenCalled()
    expect(asMock('listMrs')).not.toHaveBeenCalled()
  })

  it('装载失败：落到可重试的失败态，点重试真的再装载一次', async () => {
    const wrapper = await mountView([], () => ({ init: vi.fn(async () => false) }))
    const failed = wrapper.get('[aria-label="装载失败"]')
    expect(failed.text()).toContain('本地快照装载失败')
    expect(wrapper.text()).not.toContain('正在装载本地快照')

    asMock('init').mockResolvedValue(true)
    await failed.get('button').trigger('click')
    await flushPromises()
    expect(asMock('init')).toHaveBeenCalledTimes(2)
    expect(wrapper.find('.toolbar').exists()).toBe(true)
  })

  it('状态筛选：列表与计数同一口径查库', async () => {
    const wrapper = await mountView()
    await wrapper.findAll('.chip')[2].trigger('click')
    await flushPromises()
    expect(asMock('listMrs')).toHaveBeenLastCalledWith({ state: 'merged', limit: 200, offset: 0 })
    expect(asMock('countMrs')).toHaveBeenLastCalledWith({ state: 'merged' })
  })

  it('空态区分「从未同步」与「筛选后为空」', async () => {
    const wrapper = await mountView()
    expect(wrapper.get('[aria-label="空态"]').text()).toContain('还没有同步过任何 MR')

    const store = testStore as unknown as { syncStates: Record<string, CodeHubSyncState> }
    store.syncStates = { 'demo/a': { repoId: 'demo/a', lastSyncedAt: '2026-10-02 09:00:00', lastError: null } }
    await flushPromises()
    await wrapper.findAll('.chip')[1].trigger('click')
    await flushPromises()
    expect(wrapper.get('[aria-label="空态"]').text()).toContain('当前筛选下没有 MR')
  })

  it('列表按仓库分组，状态标签取三态文案', async () => {
    const wrapper = await mountView([
      record('demo/a', '101', 'open'),
      record('demo/a', '102', 'merged'),
      record('demo/b', '201', 'closed'),
    ])
    expect(wrapper.findAll('.list__group')).toHaveLength(2)
    expect(wrapper.findAll('.mr-state').map((node) => node.text())).toEqual(['开启', '已合并', '已关闭'])
  })

  it('缺详情才补拉：有详情的点击不发调用', async () => {
    const wrapper = await mountView([record('demo/a', '101', 'open', true), record('demo/a', '102', 'open', false)])
    await wrapper.findAll('.mr')[0].trigger('click')
    await flushPromises()
    expect(asMock('getMr')).not.toHaveBeenCalled()

    await wrapper.findAll('.mr')[1].trigger('click')
    await flushPromises()
    expect(asMock('getMr')).toHaveBeenCalledWith('demo/a', '102')
  })

  it('删除仓库：两步确认后无条件刷新，并清掉失效的筛选', async () => {
    const wrapper = await mountView([record('demo/a', '101', 'open')], (data) => ({
      repos: [repo(1, 'demo/a')],
      removeRepo: vi.fn(async () => {
        data.rows = []
      }),
    }))
    await wrapper.findAll('.repo__main')[0].trigger('click')
    await flushPromises()
    expect(asMock('listMrs')).toHaveBeenLastCalledWith({ repoId: 'demo/a', limit: 200, offset: 0 })

    const remove = wrapper.get('.repo__remove')
    await remove.trigger('click')
    expect(remove.text()).toContain('确认删除')
    await remove.trigger('click')
    await flushPromises()
    expect(asMock('removeRepo')).toHaveBeenCalledWith(1)
    // 删掉的正是当前筛选中的仓库 → 口径回到「全部仓库」，并且无条件再查一次库
    expect(asMock('listMrs')).toHaveBeenLastCalledWith({ limit: 200, offset: 0 })
  })

  it('开关写库失败：给出错误并把清单读回真值', async () => {
    const wrapper = await mountView([], () => ({
      repos: [repo(1, 'demo/a')],
      setRepoEnabled: vi.fn(async () => {
        throw new Error('数据库被占用')
      }),
    }))
    await wrapper.get('.repo__toggle input').trigger('change')
    await flushPromises()
    expect(wrapper.get('.repos__error').text()).toContain('数据库被占用')
    expect(asMock('loadRepos')).toHaveBeenCalled()
  })

  it('截断降级：状态条把「快照可能不完整」显示出来', async () => {
    const wrapper = await mountView([], () => ({ lastSummary: summary({ degraded: ['demo/a', 'demo/b'] }) }))
    expect(wrapper.get('.tag--degraded').text()).toContain('2 个仓库输出被截断')
  })
})
