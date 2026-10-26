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
let updateStore: Record<string, unknown>
// 返回 Promise 才是真路由语义（重复导航会 reject，组件侧靠 `.catch` 兜住未处理拒绝）
const push = vi.fn(async () => undefined)

vi.mock('@/stores/codehub', () => ({ useCodehubStore: () => codehubStore }))
vi.mock('@/stores/app', () => ({ useAppStore: () => appStore }))
vi.mock('@/stores/welink', () => ({ useWelinkStore: () => welinkStore }))
vi.mock('@/stores/group', () => ({ useGroupStore: () => groupStore }))
// 自动更新（design-auto-update）：工作台只读 status/hasUpdate 呈现小红点，mock 语义与
// store 聚合口径一致（hasUpdate = enabled && (available|ready|hint)）
vi.mock('@/stores/update', () => ({ useUpdateStore: () => updateStore }))
// bridge 必须一起 mock：logger 的出口会访问 bridge.appendLog —— 摘要装载失败态
// 的 logger.warn 一踩就到，缺了它 catch 块自身会抛，把「重试恢复」路径整条打挂。
vi.mock('@/api', () => ({ platform: 'web', bridge: { appendLog: vi.fn(() => Promise.resolve()) } }))
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
    group?: Record<string, unknown>
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
    ...overrides.group,
  })
  return mount(DashboardView)
}

const panelTitles = (wrapper: ReturnType<typeof mountView>) =>
  wrapper.findAll('.panel__title').map((node) => node.text())

describe('DashboardView', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    updateStore = {
      status: { state: 'idle', latest: null, progress: null, error: null, lastCheckAt: null, hintVersion: null },
      hasUpdate: false,
      busy: false,
    }
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

  // ——— 摘要装载失败必须是可见态（P1：静默降级收口）———
  // 反证依据：失败态文案与重试按钮是本轮新增的模板分支，修复前这些断言
  // 会因元素不存在而红（旧实现四路 catch 只写 logger.warn，界面落入
  // 「暂无待审」/「历史建群 0 次」，与「真的没有」完全同形）。

  it('WeLink 摘要装载失败：待审卡片显示失败态而不是「暂无待审」，重试后恢复', async () => {
    let calls = 0
    const wrapper = mountView({
      welink: {
        reviewCount: 0,
        unreadTotal: 0,
        settings: { sendMode: 'auto' },
        init: vi.fn(async () => {
          calls += 1
          if (calls === 1) throw new Error('库锁等待超时')
          return { panicRecovered: false }
        }),
        listJobs: vi.fn(async () => []),
      },
    })
    await flushPromises()
    const queue = wrapper.get('[aria-label="待审回复队列"]')
    // 失败时不得显示「暂无待审」—— 那会把「没加载上」说成「确实是空」
    expect(queue.text()).toContain('待审摘要装载失败')
    expect(queue.text()).not.toContain('暂无待审')
    expect(wrapper.get('[aria-label="WeLink 域概览"]').text()).toContain('助手摘要装载失败')

    // 精确选中失败态里的「重试」钮：卡片头部还有一个同类 class 的「去处理」
    // 导航钮，用 button.link 会命中它（点击走路由、不触发 init）——aria-label 区分
    await queue.get('[aria-label="重试装载待审摘要"]').trigger('click')
    await flushPromises()
    expect(welinkStore.init).toHaveBeenCalledTimes(2)
    expect(queue.text()).toContain('暂无待审')
    expect(queue.text()).not.toContain('待审摘要装载失败')
  })

  it('CodeHub 摘要装载失败：MR 卡片显示失败态而不是「没有开启中的 MR」', async () => {
    const wrapper = mountView({
      codehub: {
        init: vi.fn(async () => {
          throw new Error('快照库不可用')
        }),
      },
    })
    await flushPromises()
    const card = wrapper.get('[aria-label="开启中的 MR"]')
    expect(card.text()).toContain('MR 快照装载失败')
    expect(card.text()).not.toContain('没有开启中的 MR')
  })

  it('建群摘要装载失败：面板显示失败提示而不是「历史建群 0 次」', async () => {
    const wrapper = mountView({
      group: {
        init: vi.fn(async () => {
          throw new Error('建群库不可用')
        }),
        countJobs: vi.fn(async () => 5),
      },
    })
    await flushPromises()
    const panel = wrapper.get('[aria-label="WeLink 域概览"]')
    expect(panel.text()).toContain('建群摘要失败')
    expect(panel.text()).not.toContain('历史建群 5 次')
  })

  it('运行信息刷新：store.load() 吞错，本层补 busy 与可见失败提示', async () => {
    const wrapper = mountView()
    await flushPromises()
    let release: () => void = () => {}
    appStore.load = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        }),
    )
    const button = wrapper.get('button[aria-label="刷新运行信息"]')
    const clicked = button.trigger('click')
    await flushPromises()
    // 执行中：按钮禁用 + 旋转态（失败期间不可重复点击）
    expect(button.attributes('disabled')).toBeDefined()
    expect(button.classes()).toContain('is-busy')
    release()
    await clicked
    await flushPromises()
    expect(button.attributes('disabled')).toBeUndefined()

    // 失败可见：load 内部只落日志，提示由本层补
    appStore.load = vi.fn(async () => {
      throw new Error('配置读取失败')
    })
    await button.trigger('click')
    await flushPromises()
    expect(ElMessage.error).toHaveBeenCalledWith('配置读取失败')
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

    const groupEntry = welinkPanel.findAll('.entry').find((node) => node.text().includes('快速建群'))
    if (!groupEntry) throw new Error('快速建群入口不存在')
    await groupEntry.trigger('click')
    expect(push).toHaveBeenLastCalledWith('/groups')

    await wrapper.get('[aria-label="CodeHub 域概览"] .panel__head').trigger('click')
    expect(push).toHaveBeenLastCalledWith('/codehub')
  })
})
