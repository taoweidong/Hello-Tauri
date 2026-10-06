import { mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { reactive } from 'vue'

import { DEFAULT_WELINK_SETTINGS, type WelinkRagSettings, type WelinkSettings } from '@/types/welink'
import RagSettingsCard from './RagSettingsCard.vue'

/**
 * 「知识检索（RAG）」配置卡测试 —— 对齐 LlmSettingsCard 的四段契约：
 * 入口归一化 + 防抖上抛、热更新全量 settings、父级回写同值不重推、测试按钮走 store 探测。
 */

const store = {
  settings: { ...DEFAULT_WELINK_SETTINGS } as WelinkSettings,
  applySettings: vi.fn(),
  probeRag: vi.fn(async () => ({ latencyMs: 12, preview: '[0.91] 先查网关日志' })),
}
vi.mock('@/stores/welink', () => ({ useWelinkStore: () => store }))

const EP_STUBS = [
  'el-tag',
  'el-alert',
  'el-form',
  'el-form-item',
  'el-radio-group',
  'el-radio-button',
  'el-input',
  'el-input-number',
  'el-switch',
  'el-button',
  'el-collapse',
  'el-collapse-item',
]

function mountCard(modelValue: Partial<WelinkRagSettings>) {
  return mount(RagSettingsCard, {
    props: { modelValue },
    global: { stubs: Object.fromEntries(EP_STUBS.map((name) => [name, true])) },
  })
}

async function edit(wrapper: ReturnType<typeof mountCard>, next: Partial<WelinkRagSettings>) {
  await wrapper.setProps({ modelValue: next })
  vi.advanceTimersByTime(300)
  await wrapper.vm.$nextTick()
}

const pushes = (wrapper: ReturnType<typeof mountCard>) =>
  ((wrapper.emitted('update:modelValue') ?? []) as [WelinkRagSettings][]).map(([value]) => value)

describe('rag SettingsCard（知识检索配置卡）', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  it('越界值入口收敛（topK 夹回上限、非法地址回退默认），改动经 300ms 防抖整块上抛', async () => {
    const wrapper = mountCard({ ragSource: 'http', baseUrl: 'ftp://x', topK: 99 })
    expect(pushes(wrapper)).toHaveLength(0)
    await edit(wrapper, { ragSource: 'http', baseUrl: 'http://rag.local', topK: 99 })
    expect(pushes(wrapper)).toHaveLength(1)
    expect(pushes(wrapper)[0]).toMatchObject({ baseUrl: 'http://rag.local', topK: 10 })
  })

  it('热更新带全量 settings：其余域保持 store 当前值，不被 rag 块重置', async () => {
    store.settings = reactive({ ...DEFAULT_WELINK_SETTINGS, enabled: true, pollIntervalSec: 9 })
    const wrapper = mountCard({ ragSource: 'http', baseUrl: 'http://rag.local' })
    await edit(wrapper, { ragSource: 'http', baseUrl: 'http://rag2.local' })
    expect(store.applySettings).toHaveBeenCalledTimes(1)
    const payload = store.applySettings.mock.calls[0]![0] as WelinkSettings
    expect(payload.enabled).toBe(true)
    expect(payload.pollIntervalSec).toBe(9)
    expect(payload.rag.baseUrl).toBe('http://rag2.local')
  })

  it('父级回写自己刚上抛的同值不再触发新一轮 push（防逐键打断输入）', async () => {
    const wrapper = mountCard({ ragSource: 'http', baseUrl: 'http://rag.local' })
    await edit(wrapper, { ragSource: 'http', baseUrl: 'http://rag2.local' })
    expect(pushes(wrapper)).toHaveLength(1)
    await edit(wrapper, pushes(wrapper)[0])
    expect(pushes(wrapper)).toHaveLength(1)
  })

  it('测试检索走 store.probeRag（独立探针），结果经卡片展示', async () => {
    const wrapper = mountCard({ ragSource: 'http', baseUrl: 'http://rag.local' })
    const vm = wrapper.vm as unknown as { testRag: () => Promise<void> }
    await vm.testRag()
    expect(store.probeRag).toHaveBeenCalledTimes(1)
    const probeArg = (store.probeRag.mock.calls as unknown as [WelinkRagSettings][])[0]![0]
    expect(probeArg.baseUrl).toBe('http://rag.local')
  })
})
