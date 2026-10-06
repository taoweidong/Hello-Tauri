import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { reactive } from 'vue'

import { ElMessage } from 'element-plus'

import type { StorageLayout } from '@/types'
import type { CodeHubMrRecord } from '@/types/codehub'
import type { WelinkJob } from '@/types/welink'
import DashboardView from './DashboardView.vue'

/**
 * 工作台首页测试（workbench-home + 双域聚焦改版）。
 *
 * 首页的契约是「聚合但不越权」：所有摘要**只读本地快照与 store 状态**——
 * CodeHub 走 countMrs/listMrs（查库）、WeLink 只做 init 只读装载（不 start，
 * 轮询恢复只在助手页）、快速建群只数模板与历史；急停恢复与 WeLinkView 同款
 * 处置（写回持久层 + 显式告知）。首页只聚焦 WeLink 与 CodeHub 两个业务域，
 * 数据管理（CRUD 演示）与环境检测不再出现在首页。
 */

let codehubStore: Record<string, unknown>
let appStore: {
  info: Record<string, unknown>
  settings: { weLink: Record<string, unknown> }
  load: () => Promise<void>
}
let welinkStore: Record<string, unknown>
let groupStore: Record<string, unknown>
const push = vi.fn()

vi.mock('@/stores/codehub', () => ({ useCodehubStore: () => codehubStore }))
vi.mock('@/stores/app', () => ({ useAppStore: () => appStore }))
vi.mock('@/stores/welink', () => ({ useWelinkStore: () => welinkStore }))
vi.mock('@/stores/group', () => ({ useGroupStore: () => groupStore }))
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
    syncStates: {},
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
    status: 'stopped',
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
  return mount(DashboardView)
}

const panelTitles = (wrapper: ReturnType<typeof mountView>) =>
  wrapper.findAll('.panel__title').map((node) => node.text())

describe('DashboardView', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('双域面板聚焦业务域：WeLink 助手与 CodeHub 检视，演示域不再出现', async () => {
    const wrapper = mountView()
    await flushPromises()
    expect(panelTitles(wrapper)).toEqual(['WeLink 助手', 'CodeHub 检视'])
    // 数据管理只是 CRUD 演示域，环境检测是系统工具 —— 都不上首页
    expect(wrapper.text()).not.toContain('数据管理')
    expect(wrapper.text()).not.toContain('环境检测')
  })

  it('WeLink 面板汇总未读/待审/模板/历史建群与运行状态', async () => {
    const wrapper = mountView()
    await flushPromises()
    const panel = wrapper.get('[aria-label="WeLink 域概览"]')
    expect(panel.text()).toContain('未读消息')
    expect(panel.text()).toContain('5')
    expect(panel.text()).toContain('待审回复')
    expect(panel.text()).toContain('3')
    expect(panel.text()).toContain('建群模板')
    expect(panel.text()).toContain('2')
    expect(panel.text()).toContain('自动回复已停止')
    expect(panel.text()).toContain('历史建群 5 次')
  })

  it('CodeHub 面板汇总开启 MR/仓库/自动同步与最近同步时间', async () => {
    const wrapper = mountView({
      codehub: {
        syncStates: { 'proj-a': { repoId: 'proj-a', lastSyncedAt: '2026-10-05 18:00:00', lastError: null } },
      },
    })
    await flushPromises()
    const panel = wrapper.get('[aria-label="CodeHub 域概览"]')
    expect(panel.text()).toContain('开启中的 MR')
    expect(panel.text()).toContain('7')
    expect(panel.text()).toContain('注册仓库')
    expect(panel.text()).toContain('自动同步')
    expect(panel.text()).toContain('最近同步')
  })

  it('CodeHub 摘要读本地快照（计数 + 前 4 条预览），不触发同步', async () => {
    const wrapper = mountView()
    await flushPromises()
    expect(codehubStore.countMrs).toHaveBeenCalledWith({ state: 'open' })
    expect(codehubStore.listMrs).toHaveBeenCalledWith({ state: 'open', limit: 4, offset: 0 })
    expect(wrapper.get('[aria-label="开启中的 MR"] .queue__title').text()).toBe('修复登录态丢失')
  })

  it('CodeHub 未装载成功时面板显示「待同步」，列表显示引导空态', async () => {
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
    // 结论留在正文，完整原因放 title —— 长文案不在横条里铺开
    expect(degraded.get('.pill--warn').text()).toBe('降级')
    expect(degraded.get('.pill--warn').attributes('title')).toBe('D 盘不可用')
  })

  it('点面板头部与入口跳转到对应工作域', async () => {
    const wrapper = mountView()
    await flushPromises()
    const welinkPanel = wrapper.get('[aria-label="WeLink 域概览"]')
    await welinkPanel.get('.panel__head').trigger('click')
    expect(push).toHaveBeenLastCalledWith('/welink')

    const groupEntry = welinkPanel
      .findAll('.entry')
      .find((node) => node.text().includes('快速建群'))
    if (!groupEntry) throw new Error('快速建群入口不存在')
    await groupEntry.trigger('click')
    expect(push).toHaveBeenLastCalledWith('/groups')

    await wrapper.get('[aria-label="CodeHub 域概览"] .panel__head').trigger('click')
    expect(push).toHaveBeenLastCalledWith('/codehub')
  })
})
