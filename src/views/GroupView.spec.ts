import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 快速建群页测试（init 失败契约）。
 *
 * 页头的「建群数据初始化失败」告警是 init 唯一的用户可见出口：store.init 返回
 * false 与**直接拒绝**都必须落到这里。后者尤其容易漏 —— `await` 抛错时
 * `initFailed` 停在 false，页面只剩空模板与空历史，用户看不到任何原因。
 */
let groupStore: { init: ReturnType<typeof vi.fn> }
// 工厂在 import 阶段执行，引用普通 const 会 TDZ；vi.hoisted 与 vi.mock 同步提升。
const { loggerError } = vi.hoisted(() => ({ loggerError: vi.fn() }))

vi.mock('@/stores/group', () => ({ useGroupStore: () => groupStore }))
vi.mock('@/stores/app', () => ({ useAppStore: () => ({ settings: { weLink: {} } }) }))
vi.mock('@/api', () => ({ platform: 'web', bridge: { appendLog: vi.fn(async () => undefined) } }))
vi.mock('@/utils/logger', () => ({ logger: { error: loggerError, warn: vi.fn(), info: vi.fn() } }))
vi.mock('@/components/group/CreateTab.vue', () => ({ default: { template: '<div />' } }))
vi.mock('@/components/group/TemplateTab.vue', () => ({ default: { template: '<div />' } }))
vi.mock('@/components/group/GroupHistoryTab.vue', () => ({ default: { template: '<div />' } }))

import GroupView from './GroupView.vue'

const EP_STUBS: Record<string, unknown> = {
  'el-tag': { template: '<span><slot /></span>' },
  'el-button': { template: '<button><slot /></button>' },
  'el-alert': { template: '<div class="alert-stub">{{ title }}</div>', props: ['title'] },
}

function mountView() {
  return mount(GroupView, { global: { stubs: EP_STUBS as never } })
}

beforeEach(() => {
  groupStore = { init: vi.fn() }
  loggerError.mockClear()
})

describe('views/GroupView（快速建群页）', () => {
  it('init 成功：无失败告警', async () => {
    groupStore.init.mockResolvedValue(true)
    const wrapper = mountView()
    await flushPromises()
    expect(groupStore.init).toHaveBeenCalledTimes(1)
    expect(wrapper.text()).not.toContain('建群数据初始化失败')
  })

  it('init 拒绝：告警可见并留痕（不能停在「静默空页」）', async () => {
    groupStore.init.mockRejectedValue(new Error('数据表迁移失败'))
    const wrapper = mountView()
    await flushPromises()
    expect(wrapper.text()).toContain('建群数据初始化失败')
    expect(loggerError).toHaveBeenCalledWith(expect.stringContaining('快速建群初始化失败'), expect.any(Error))
  })
})
