import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { reactive } from 'vue'

import type { StorageLayout } from '@/types'
import DashboardView from './DashboardView.vue'

/**
 * 工作台首页测试（personal-workbench D7）。
 *
 * 首页的契约是「聚合但不越权」：域卡片摘要**只读本地快照与 store 状态**，
 * CodeHub 那张卡走 `countMrs`（查库）而不是同步管线；存储状态必须能看出降级。
 * el-table 属于 Element Plus，浏览器测试里整体桩掉，专注卡片与信息行。
 */

let codehubStore: Record<string, unknown>
let appStore: Record<string, unknown>
let welinkStore: Record<string, unknown>
let tableStore: Record<string, unknown>
const push = vi.fn()

vi.mock('@/stores/codehub', () => ({ useCodehubStore: () => codehubStore }))
vi.mock('@/stores/app', () => ({ useAppStore: () => appStore }))
vi.mock('@/stores/welink', () => ({ useWelinkStore: () => welinkStore }))
vi.mock('@/stores/table', () => ({ useTableStore: () => tableStore, CATEGORIES: ['食材', '交通', '其他'] }))
vi.mock('@/api', () => ({ platform: 'web' }))
vi.mock('vue-router', () => ({ useRouter: () => ({ push }) }))

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

function mountView(codehub: Record<string, unknown> = {}, storage: Partial<StorageLayout> = {}) {
  codehubStore = reactive({ init: vi.fn(async () => true), countMrs: vi.fn(async () => 7), ...codehub })
  appStore = reactive({ info: { platform: 'web', arch: 'x64', version: '0.1.0', tauriVersion: '-', configPath: 'c.json', storage: layout(storage) } })
  welinkStore = reactive({ reviewCount: 3 })
  tableStore = reactive({
    stats: { total: 12, active: 9, inactive: 3, amount: 1234 },
    rows: [{ id: 1, name: 'A', category: '食材', owner: 'u', status: 'active', amount: 10 }],
    recent: [],
  })
  const wrapper = mount(DashboardView, { global: { stubs: { 'el-table': true, 'el-table-column': true } } })
  return { wrapper }
}

const cardTitles = (wrapper: ReturnType<typeof mountView>['wrapper']) =>
  wrapper.findAll('.domain__title').map((node) => node.text())

describe('DashboardView', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('四张工作域卡片齐全（welink / codehub / 数据管理 / 环境检测）', async () => {
    const { wrapper } = await mountView()
    await flushPromises()
    expect(cardTitles(wrapper)).toEqual(['WeLink 助手', 'CodeHub 检视', '数据管理', '环境检测'])
    expect(wrapper.findAll('.domain')).toHaveLength(4)
  })

  it('CodeHub 摘要读本地快照计数，不触发同步', async () => {
    const { wrapper } = await mountView()
    await flushPromises()
    expect(codehubStore.countMrs).toHaveBeenCalledWith({ state: 'open' })
    expect(wrapper.get('.domain:nth-child(2) .domain__metric').text()).toBe('开启 7')
  })

  it('未装载成功时显示「待同步」，装载失败不卡死页面', async () => {
    const { wrapper } = await mountView({ init: vi.fn(async () => false) })
    await flushPromises()
    expect(wrapper.text()).toContain('待同步')
    expect(codehubStore.countMrs).not.toHaveBeenCalled()
  })

  it('存储状态：正常与降级都读得出来（内网迁移的第一手信息）', async () => {
    const ok = (await mountView()).wrapper
    await flushPromises()
    expect(ok.text()).toContain('数据根目录')
    expect(ok.text()).toContain('D:\\TangYuan')
    expect(ok.text()).toContain('正常')

    const degraded = (await mountView({}, { fallback: true, note: 'D 盘不可用' })).wrapper
    await flushPromises()
    // 结论留在正文，完整原因放 title —— 长文案不在 300px 侧栏里铺开
    expect(degraded.text()).toContain('降级')
    expect(degraded.find('dd[title="D 盘不可用"]').exists()).toBe(true)
  })

  it('指标条四格与待审徽标来自 store 状态', async () => {
    const { wrapper } = await mountView()
    await flushPromises()
    expect(wrapper.findAll('.ledger__cell')).toHaveLength(4)
    expect(wrapper.text()).toContain('待审 3')
    expect(wrapper.text()).toContain('共 12 条')
  })

  it('点卡片跳转到对应工作域', async () => {
    const { wrapper } = await mountView()
    await flushPromises()
    await wrapper.findAll('.domain')[2].trigger('click')
    expect(push).toHaveBeenCalledWith('/table')
  })
})
