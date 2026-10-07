import { mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { reactive } from 'vue'

import { DEFAULT_WELINK_SETTINGS, type WelinkSettings, type WelinkSkill } from '@/types/welink'
import LlmSettingsCard from './LlmSettingsCard.vue'

/**
 * 「大模型（Agent）」配置卡测试（design-llm-connection，2026-10-04 配置卡拆分）。
 *
 * Element Plus 组件整体桩掉，测这张卡独有的四段逻辑：
 *  1. **入口归一化 + 防抖上抛**：配置是可手改的 JSON，越界值（超时）必须在进入
 *      draft 时收敛，且 300ms 防抖 —— 逐键 push 会逐键热更新与写日志；
 *  2. **热更新必须是全量 settings**：applySettings 不做字段级合并，只传 { agent }
 *     会把其余域重置回默认值 —— 这是 agent 块拆出独立卡后最容易踩的坑；
 *  3. **父级回写同值不再触发新一轮 push**（评审 F-2，防逐键打断输入）；与
 *     SettingsCard 的「agent 透传」约定配合，双卡并存不互踩；
 *  4. 误配置告警（openai 缺 model）只提示不拦截保存。
 */

const store = {
  settings: { ...DEFAULT_WELINK_SETTINGS } as WelinkSettings,
  applySettings: vi.fn(),
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
  'el-button',
  'el-collapse',
  'el-collapse-item',
]

function mountCard(modelValue: Partial<WelinkSettings['agent']>) {
  return mount(LlmSettingsCard, {
    props: { modelValue },
    global: { stubs: Object.fromEntries(EP_STUBS.map((name) => [name, true])) },
  })
}

/** 模拟父级回写（桩组件不可交互，走 props 这条真实存在的入口） */
async function edit(wrapper: ReturnType<typeof mountCard>, next: Partial<WelinkSettings['agent']>) {
  await wrapper.setProps({ modelValue: next })
  vi.advanceTimersByTime(300)
  await wrapper.vm.$nextTick()
}

const pushes = (wrapper: ReturnType<typeof mountCard>) =>
  ((wrapper.emitted('update:modelValue') ?? []) as [WelinkSettings['agent']][]).map(([value]) => value)

describe('llm SettingsCard（大模型配置卡）', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  it('越界的超时值在入口被钳回下限，且改动经 300ms 防抖后整块上抛', async () => {
    const wrapper = mountCard({ agentSource: 'http', baseUrl: 'http://x', model: 'm', timeoutMs: 999_999 })
    expect(pushes(wrapper)).toHaveLength(0)
    await edit(wrapper, { agentSource: 'http', baseUrl: 'http://x', model: 'm', timeoutMs: 500 })
    expect(pushes(wrapper)).toHaveLength(1)
    expect(pushes(wrapper)[0]).toMatchObject({ agentSource: 'http', timeoutMs: 1000 })
  })

  it('热更新带全量 settings：其余域保持 store 当前值，不被 agent 块重置', async () => {
    store.settings = reactive({ ...DEFAULT_WELINK_SETTINGS, enabled: true, pollIntervalSec: 9 })
    const wrapper = mountCard({ agentSource: 'http', baseUrl: 'http://x', endpoint: '/chat' })
    await edit(wrapper, { agentSource: 'http', baseUrl: 'http://x', endpoint: '/chat2' })
    expect(store.applySettings).toHaveBeenCalledTimes(1)
    const payload = store.applySettings.mock.calls[0]![0] as WelinkSettings
    expect(payload.enabled).toBe(true)
    expect(payload.pollIntervalSec).toBe(9)
    expect(payload.agent.endpoint).toBe('/chat2')
  })

  it('父级回写自己刚上抛的同值不再触发新一轮 push（防逐键打断输入）', async () => {
    const wrapper = mountCard({ agentSource: 'http', baseUrl: 'http://x', model: 'm' })
    await edit(wrapper, { agentSource: 'http', baseUrl: 'http://x:8080', model: 'm' })
    expect(pushes(wrapper)).toHaveLength(1)

    await edit(wrapper, pushes(wrapper)[0])
    expect(pushes(wrapper)).toHaveLength(1)
  })

  it('误配置告警：openai + model 缺失 → 显示提示；来源 mock 或配置齐全 → 不显示', async () => {
    const noModel = mountCard({ agentSource: 'http', baseUrl: 'http://x', model: '   ' })
    await noModel.vm.$nextTick()
    expect(noModel.find('.llm__alert').exists()).toBe(true)

    const ready = mountCard({ agentSource: 'http', baseUrl: 'http://x', model: 'qwen' })
    await ready.vm.$nextTick()
    expect(ready.find('.llm__alert').exists()).toBe(false)

    const mock = mountCard({ agentSource: 'mock' })
    await mock.vm.$nextTick()
    expect(mock.find('.llm__alert').exists()).toBe(false)
  })

  it('技能清单随 agent 块归一化透传：字段收敛（slug/清洗）但条目不丢', async () => {
    const skill: WelinkSkill = {
      id: 'Fault Fix',
      name: '故障咨询',
      description: '报错类',
      enabled: false,
      keywords: [' 报错 ', ''],
      promptTemplate: '',
      knowledge: ' KB ',
      reviewMode: 'manual',
      retrieval: { enabled: false },
      knowledgeDocs: [],
    }
    const wrapper = mountCard({ agentSource: 'http', baseUrl: 'http://x', model: 'm', skills: [skill] })
    // 改动一个无关字段触发 push（edit 的语义是「用户改了配置」）
    await edit(wrapper, { agentSource: 'http', baseUrl: 'http://x', model: 'm2', skills: [skill] })
    expect(pushes(wrapper)).toHaveLength(1)
    const pushed = pushes(wrapper)[0]
    expect(pushed.model).toBe('m2')
    expect(pushed.skills).toHaveLength(1)
    expect(pushed.skills[0]).toMatchObject({
      id: 'fault-fix',
      name: '故障咨询',
      keywords: ['报错'],
      reviewMode: 'manual',
      knowledge: 'KB',
    })
    expect(pushed.fallbackKnowledge).toBe('')
  })

  it('父级回写含技能清单的同值不再触发新一轮 push（防顶回扩展到 skills）', async () => {
    const skill: WelinkSkill = { id: 'a', name: '故障咨询', description: '', enabled: true, keywords: [], promptTemplate: '', knowledge: '', reviewMode: 'auto', retrieval: { enabled: false }, knowledgeDocs: [] }
    const wrapper = mountCard({ agentSource: 'http', baseUrl: 'http://x', model: 'm', skills: [skill] })
    await edit(wrapper, { agentSource: 'http', baseUrl: 'http://x:8080', model: 'm', skills: [skill] })
    expect(pushes(wrapper)).toHaveLength(1)

    await edit(wrapper, pushes(wrapper)[0])
    expect(pushes(wrapper)).toHaveLength(1)
  })
})
