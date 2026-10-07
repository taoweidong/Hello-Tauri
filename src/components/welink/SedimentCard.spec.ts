import { mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 「知识沉淀」配置卡测试（knowledge-sedimentation 6.1）。
 *
 * 两个 store 都打假件：welinkStore 提供配置回显与 applySettings 捕获（断言
 * 防抖上抛与归一化），knowledgeStore 提供 runOnce/lastReport/logs（断言「立即
 * 提取」与结果提示）。钉住四条行为：配置回显与推送、auto 模式风险提示、
 * web 模式整体降级、提取结果的四种提示分支。
 */
const state: { platform: 'tauri' | 'web' } = { platform: 'tauri' }

vi.mock('@/api', () => ({
  get platform() {
    return state.platform
  },
}))

vi.mock('element-plus', () => ({
  ElMessage: { success: vi.fn(), warning: vi.fn(), error: vi.fn() },
}))

import { ElMessage } from 'element-plus'
import SedimentCard from './SedimentCard.vue'
import type { WelinkSedimentSettings } from '@/types/welink'

const applySettings = vi.fn()
const runOnce = vi.fn()

vi.mock('@/stores/welink', () => ({
  useWelinkStore: () => ({
    settings: {},
    conversations: [],
    loadConversations: async () => undefined,
    applySettings,
  }),
}))

vi.mock('@/stores/welink/knowledge', () => ({
  useKnowledgeStore: () => ({
    fsAvailable: state.platform === 'tauri',
    busy: false,
    lastReport: null,
    logs: [],
    loadLogs: async () => undefined,
    runOnce,
  }),
}))

const EP_STUBS: Record<string, unknown> = {
  'el-tag': { template: '<span class="tag-stub"><slot /></span>' },
  'el-button': { template: '<button class="btn-stub" @click="$emit(\'click\')"><slot /></button>', emits: ['click'] },
  'el-input': true,
  'el-input-number': true,
  'el-select': true,
  'el-option': true,
  'el-switch': true,
  'el-radio-group': true,
  'el-radio-button': true,
  'el-form': { template: '<form><slot /></form>' },
  'el-form-item': { template: '<div class="form-item-stub"><slot /></div>' },
  'el-collapse': { template: '<div><slot /></div>' },
  'el-collapse-item': { template: '<div><slot /></div>' },
  'el-alert': { template: '<div class="alert-stub">{{ title }}<slot /></div>', props: ['title'] },
}

const BASE: WelinkSedimentSettings = {
  enabled: true,
  mode: 'manual',
  sessions: ['G-1001'],
  intervalHours: 6,
  qaArchive: true,
  docsMaxChars: 3000,
}

function mountCard(modelValue: Partial<WelinkSedimentSettings> = {}) {
  let current = modelValue
  const wrapper = mount(SedimentCard, {
    props: {
      modelValue: current,
      'onUpdate:modelValue': (value: WelinkSedimentSettings) => {
        current = value
      },
    },
    global: { stubs: EP_STUBS as never },
  })
  return { wrapper, current: () => current }
}

beforeEach(() => {
  state.platform = 'tauri'
  vi.clearAllMocks()
})

describe('welink/SedimentCard（知识沉淀配置卡）', () => {
  it('配置回显：modelValue 进草稿后随表单展示（运行中徽标）', async () => {
    const { wrapper } = mountCard(BASE)
    await wrapper.vm.$nextTick()
    expect(wrapper.text()).toContain('知识沉淀')
    expect(wrapper.text()).toContain('运行中')
  })

  it('改动经防抖上抛：applySettings 收到归一化后的 sediment 块（越界值收敛）', async () => {
    vi.useFakeTimers()
    const { wrapper, current } = mountCard({ ...BASE, docsMaxChars: 99 })
    const vm = wrapper.vm as unknown as { draft: WelinkSedimentSettings }
    vm.draft.docsMaxChars = 99_000
    vm.draft.mode = 'auto'
    await vi.advanceTimersByTimeAsync(400)
    expect(applySettings).toHaveBeenCalledTimes(1)
    const pushed = applySettings.mock.calls[0][0].sediment as WelinkSedimentSettings
    expect(pushed.docsMaxChars).toBe(8000) // 越界收敛到上限
    expect(pushed.mode).toBe('auto')
    expect(current().mode).toBe('auto')
    vi.useRealTimers()
  })

  it('auto 模式出现风险提示（免审直通显式告知）', async () => {
    const { wrapper } = mountCard({ ...BASE, mode: 'auto' })
    await wrapper.vm.$nextTick()
    expect(wrapper.text()).toContain('免审直通')
  })

  it('立即提取：调用 store.runOnce 并按报告内容给出成功提示', async () => {
    runOnce.mockResolvedValue({
      ranAt: '2026-10-06 10:00:00',
      messageCount: 2,
      announcementCount: 1,
      qaArchived: 3,
      draftCount: 1,
      skipped: null,
      error: '',
    })
    const { wrapper } = mountCard(BASE)
    const vm = wrapper.vm as unknown as { extractNow: () => Promise<void> }
    await vm.extractNow()
    expect(runOnce).toHaveBeenCalledTimes(1)
    expect(ElMessage.success).toHaveBeenCalledWith(expect.stringContaining('新增知识 1 条'))
  })

  it('立即提取的提示分支：停用 / 连续失败 / 局部异常', async () => {
    const { wrapper } = mountCard(BASE)
    const vm = wrapper.vm as unknown as { extractNow: () => Promise<void> }
    runOnce.mockResolvedValue({
      ranAt: 'x',
      messageCount: 0,
      announcementCount: 0,
      qaArchived: 0,
      draftCount: 0,
      skipped: 'disabled',
      error: '',
    })
    await vm.extractNow()
    expect(ElMessage.warning).toHaveBeenCalledWith('知识沉淀总开关未开启')

    runOnce.mockResolvedValue({
      ranAt: 'x',
      messageCount: 0,
      announcementCount: 0,
      qaArchived: 0,
      draftCount: 0,
      skipped: 'fail_streak',
      error: '',
    })
    await vm.extractNow()
    expect(ElMessage.error).toHaveBeenCalledWith(expect.stringContaining('连续失败'))

    runOnce.mockResolvedValue({
      ranAt: 'x',
      messageCount: 1,
      announcementCount: 0,
      qaArchived: 0,
      draftCount: 0,
      skipped: null,
      error: '问答归档失败：boom',
    })
    await vm.extractNow()
    expect(ElMessage.warning).toHaveBeenCalledWith(expect.stringContaining('问答归档失败：boom'))
  })

  it('web 调试模式：整体降级提示（沉淀管理需桌面模式）', async () => {
    state.platform = 'web'
    const { wrapper } = mountCard(BASE)
    await wrapper.vm.$nextTick()
    expect(wrapper.text()).toContain('知识沉淀需桌面模式')
  })
})
