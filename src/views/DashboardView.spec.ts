import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { reactive } from 'vue'

import { ElMessage } from 'element-plus'

import type { StorageLayout } from '@/types'
import type { CodeHubMrRecord } from '@/types/codehub'
import type { WelinkJob } from '@/types/welink'
import DashboardView from './DashboardView.vue'

/**
 * 工作台首页测试（workbench-home + 待办聚合改版）。
 *
 * 首页的契约是「聚合但不越权」：所有摘要**只读本地快照与 store 状态**——
 * CodeHub 走 countMrs/listMrs（查库）、WeLink 只做 init 只读装载（不 start，
 * 轮询恢复只在助手页）、快速建群只数模板与历史；急停恢复与 WeLinkView 同款
 * 处置（写回持久层 + 显式告知）。el-* 组件已不进首页，无需桩。
 */

let codehubStore: Record<string, unknown>
let appStore: {
  info: Record<string, unknown>
  settings: { weLink: Record<string, unknown> }
  load: () => Promise<void>
}
let welinkStore: Record<string, unknown>
let groupStore: Record<string, unknown>
let tableStore: Record<string, unknown>
const push = vi.fn()

vi.mock('@/stores/codehub', () => ({ useCodehubStore: () => codehubStore }))
vi.mock('@/stores/app', () => ({ useAppStore: () => appStore }))
vi.mock('@/stores/welink', () => ({ useWelinkStore: () => welinkStore }))
vi.mock('@/stores/group', () => ({ useGroupStore: () => groupStore }))
vi.mock('@/stores/table', () => ({ useTableStore: () => tableStore, CATEGORIES: ['食材', '交通', '其他'] }))
vi.mock('@/api', () => ({ platform: 'web' }))
vi.mock('vue-router', () => ({ useRouter: () => ({ push }) }))
vi.mock('element-plus', () => ({ ElMessage: { error: vi.fn(), success: vi.fn(), info: vi.fn() } }))

function layout(overrides: Partial<StorageLayout> = {}): StorageLayout {
  return {
    root: 'D:\\TangYuan',
    preferredRoot: 'D:\\TangYuan',
    configFile: 'D:\\TangYuan\\config\\config.json',
    tableFile: 'D:\\TangYuan\\data\\table.json',
    dbFile: 'D:\\TangYuan\\data\\app.db',
    logsDir: 'D:\\TangYuan\\logs',
    fallback: false,
    note: '',
    ...overrides,
  }
}

function holdingJob(overrides: Partial<WelinkJob> = {}): WelinkJob {
  return {
    pk: 1,
    triggerMsgPk: 11,
    triggerType: 'group_at_me',
    targetType: 'group',
    targetId: 'cid:88',
    sendModeUsed: 'manual',
    contextSnapshot: '',
    draft: '明天上午十点开评审会。',
    status: 'ready',
    attempts: 0,
    lastError: '',
    skipReason: '',
    holdReason: 'manual',
    skillId: '',
    skillName: '',
    skillSource: '',
    rating: null,
    createdAt: '2026-10-06 09:30:00',
    updatedAt: '2026-10-06 09:30:00',
    finishedAt: null,
    triggerSummary: '明天的评审会定在几点？',
    targetTitle: '项目支撑群',
    ...overrides,
  }
}

function mrRecord(overrides: Partial<CodeHubMrRecord['summary']> = {}): CodeHubMrRecord {
  const summary: CodeHubMrRecord['summary'] = {
    repoId: 'proj-a',
    mrIid: '12',
    title: '修复登录态丢失',
    state: 'open',
    author: 'dev1',
    sourceBranch: 'fix/login',
    targetBranch: 'main',
    updatedAt: '2026-10-05 18:00:00',
    webUrl: '',
    review: { reviewers: [], approvals: 0, unresolved: 0, lastActivityAt: '' },
    ...overrides,
  }
  return { summary, detail: null }
}

function mountView(
  overrides: {
    codehub?: Record<string, unknown>
    storage?: Partial<StorageLayout>
    welink?: Record<string, unknown>
  } = {},
) {
  codehubStore = reactive({
    init: vi.fn(async () => true),
    countMrs: vi.fn(async () => 7),
    listMrs: vi.fn(async () => [mrRecord()]),
    repos: [{ pk: 1, repoId: 'proj-a', name: 'proj-a' }],
    autoOn: true,
    ...overrides.codehub,
  })
  appStore = reactive({
    info: {
      platform: 'web',
      arch: 'x64',
      version: '0.1.0',
      tauriVersion: '-',
      configPath: 'c.json',
      storage: layout(overrides.storage),
    },
    settings: { weLink: { sendMode: 'auto' } },
    load: vi.fn(async () => undefined),
  })
  welinkStore = reactive({
    reviewCount: 3,
    unreadTotal: 5,
    statusText: '已停止',
    settings: { sendMode: 'auto' },
    init: vi.fn(async () => ({ panicRecovered: false })),
    listJobs: vi.fn(async () => [holdingJob()]),
    holdLabel: (reason: string) => (reason === 'manual' ? '人工确认' : reason),
    ...overrides.welink,
  })
  groupStore = reactive({
    templates: [{ pk: 1 }, { pk: 2 }],
    templatesLoaded: true,
    init: vi.fn(async () => true),
    countJobs: vi.fn(async () => 5),
  })
  tableStore = reactive({
    stats: { total: 12, active: 9, inactive: 3, amount: 309100 },
    rows: [{ id: 1, name: 'A', category: '食材', owner: 'u', status: 'active', amount: 10 }],
  })
  return mount(DashboardView)
}

const cardTitles = (wrapper: ReturnType<typeof mountView>) =>
  wrapper.findAll('.domain__title').map((node) => node.text())

describe('DashboardView', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('五张工作域卡片齐全（welink / 快速建群 / codehub / 数据管理 / 环境检测）', async () => {
    const wrapper = mountView()
    await flushPromises()
    expect(cardTitles(wrapper)).toEqual(['WeLink 助手', '快速建群', 'CodeHub 检视', '数据管理', '环境检测'])
  })

  it('域卡主指标与次级上下文来自 store 聚合', async () => {
    const wrapper = mountView()
    await flushPromises()
    const cards = wrapper.findAll('.domain')
    expect(cards[0].text()).toContain('3')
    expect(cards[0].text()).toContain('条待审')
    expect(cards[0].text()).toContain('未读 5 · 已停止')
    expect(cards[1].text()).toContain('2')
    expect(cards[1].text()).toContain('套模板')
    expect(cards[1].text()).toContain('历史建群 5 次')
    expect(cards[2].text()).toContain('7')
    expect(cards[2].text()).toContain('个开启')
    expect(cards[2].text()).toContain('自动同步开')
    expect(cards[3].text()).toContain('12')
    expect(cards[3].text()).toContain('条记录')
  })

  it('CodeHub 摘要读本地快照（计数 + 前 4 条预览），不触发同步', async () => {
    const wrapper = mountView()
    await flushPromises()
    expect(codehubStore.countMrs).toHaveBeenCalledWith({ state: 'open' })
    expect(codehubStore.listMrs).toHaveBeenCalledWith({ state: 'open', limit: 4, offset: 0 })
    expect(wrapper.get('[aria-label="开启中的 MR"] .queue__title').text()).toBe('修复登录态丢失')
  })

  it('CodeHub 未装载成功时卡片显示「待同步」，列表显示引导空态', async () => {
    const wrapper = mountView({ codehub: { init: vi.fn(async () => false) } })
    await flushPromises()
    expect(wrapper.text()).toContain('待同步')
    expect(codehubStore.countMrs).not.toHaveBeenCalled()
    expect(wrapper.get('[aria-label="开启中的 MR"]').text()).toContain('快照待同步')
  })

  it('WeLink 只读装载：init 收到应用配置，列表查询只看待审（onlyHolding）', async () => {
    const wrapper = mountView()
    await flushPromises()
    expect(welinkStore.init).toHaveBeenCalledWith(appStore.settings.weLink)
    expect(welinkStore.listJobs).toHaveBeenCalledWith({ onlyHolding: true, limit: 4, offset: 0 })
    const queue = wrapper.get('[aria-label="待审回复队列"]')
    expect(queue.find('.queue__title').text()).toBe('项目支撑群')
    expect(queue.text()).toContain('人工确认')
  })

  it('待审数量变化时队列预览跟随刷新', async () => {
    mountView()
    await flushPromises()
    ;(welinkStore as { listJobs: ReturnType<typeof vi.fn> }).listJobs.mockClear()
    welinkStore.reviewCount = 4
    await flushPromises()
    expect(welinkStore.listJobs).toHaveBeenCalledWith({ onlyHolding: true, limit: 4, offset: 0 })
  })

  it('待审为空时显示平稳空态', async () => {
    const wrapper = mountView()
    welinkStore.listJobs = vi.fn(async () => [])
    welinkStore.reviewCount = 0
    await flushPromises()
    expect(wrapper.get('[aria-label="待审回复队列"]').text()).toContain('暂无待审')
  })

  it('急停恢复与 WeLinkView 同款处置：降级写回应用配置并显式告知', async () => {
    mountView({
      welink: {
        reviewCount: 0,
        unreadTotal: 0,
        settings: { sendMode: 'auto', panicked: false },
        init: vi.fn(async () => ({ panicRecovered: true })),
        listJobs: vi.fn(async () => []),
      },
    })
    await flushPromises()
    expect(appStore.settings.weLink).toMatchObject({ sendMode: 'manual', panicked: false })
    expect(ElMessage.error).toHaveBeenCalledWith('上次会话以「一键全停」结束：已降为人工确认模式，未自动恢复外发')
  })

  it('快速建群摘要：init 幂等装载后统计历史次数', async () => {
    mountView()
    await flushPromises()
    expect(groupStore.init).toHaveBeenCalled()
    expect(groupStore.countJobs).toHaveBeenCalledWith({})
  })

  it('存储状态：正常与降级都读得出来（内网迁移的第一手信息）', async () => {
    const ok = mountView()
    await flushPromises()
    expect(ok.text()).toContain('数据根目录')
    expect(ok.text()).toContain('D:\\TangYuan')
    expect(ok.get('.pill--ok').text()).toBe('正常')

    const degraded = mountView({ storage: { fallback: true, note: 'D 盘不可用' } })
    await flushPromises()
    // 结论留在正文，完整原因放 title —— 长文案不在 320px 侧栏里铺开
    expect(degraded.get('.pill--warn').text()).toBe('降级')
    expect(degraded.get('.pill--warn').attributes('title')).toBe('D 盘不可用')
  })

  it('点卡片跳转到对应工作域', async () => {
    const wrapper = mountView()
    await flushPromises()
    await wrapper.findAll('.domain')[3].trigger('click')
    expect(push).toHaveBeenCalledWith('/table')
  })
})
