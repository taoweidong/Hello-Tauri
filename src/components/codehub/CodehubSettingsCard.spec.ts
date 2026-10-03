import { mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { reactive } from 'vue'

import type { CodeHubSettings } from '@/types/codehub'
import { CODEHUB_MAX_BATCH } from '@/types/codehub'
import SettingsCard from './CodehubSettingsCard.vue'

/**
 * 「CodeHub 连接」配置卡测试（personal-workbench D6）。
 *
 * Element Plus 组件在测试里整体桩掉，测的是这张卡独有的三段逻辑：
 *  1. **入口归一化 + 防抖上抛**：配置是可手改的 JSON，越界值（单批上限、间隔）必须
 *     在进入 draft 时收敛，且 300ms 防抖 —— 逐键 push 会让 app store 逐键写盘；
 *  2. **保存闸门**：选了真实 CLI 却没填路径 = 每次同步都失败，拦在 valid 信号里；
 *  3. **凭据遮蔽时机**：token 一进归一化草稿就登记进遮蔽注册表，不等保存动作。
 */

const logger = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }))
const registerSecret = vi.hoisted(() => vi.fn())
vi.mock('@/utils/logger', () => ({ logger, registerSecret }))

let store: Record<string, unknown>
vi.mock('@/stores/codehub', () => ({ useCodehubStore: () => store }))

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
]

function mountCard(modelValue: Partial<CodeHubSettings>) {
  store = reactive({ verifyConnection: vi.fn(async () => ({ ok: true, detail: '可用' })) })
  return mount(SettingsCard, {
    props: { modelValue },
    global: { stubs: Object.fromEntries(EP_STUBS.map((name) => [name, true])) },
  })
}

/** 模拟用户在表单里改值（桩组件不可交互，走 props 回写这条真实存在的入口） */
async function edit(wrapper: ReturnType<typeof mountCard>, next: Partial<CodeHubSettings>) {
  await wrapper.setProps({ modelValue: next })
  vi.advanceTimersByTime(300)
  await wrapper.vm.$nextTick()
}

const pushes = (wrapper: ReturnType<typeof mountCard>) =>
  ((wrapper.emitted('update:modelValue') ?? []) as [CodeHubSettings][]).map(([value]) => value)

describe('codehub SettingsCard', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  it('越界的单批上限在入口被钳到 CODEHUB_MAX_BATCH', async () => {
    const wrapper = mountCard({ source: 'cli', cliPath: 'p', token: 't', pullBatchLimit: 50 })
    expect(pushes(wrapper)).toHaveLength(0)
    await edit(wrapper, { source: 'cli', cliPath: 'p', token: 't', pullBatchLimit: 9999 })
    expect(pushes(wrapper)).toHaveLength(1)
    expect(pushes(wrapper)[0]).toMatchObject({ source: 'cli', pullBatchLimit: CODEHUB_MAX_BATCH })
  })

  it('token 在归一化上抛时就登记为待遮蔽凭据（不等保存）', async () => {
    const wrapper = mountCard({ source: 'cli', cliPath: 'p', token: 't' })
    await edit(wrapper, { source: 'cli', cliPath: 'p', token: 'secret-token' })
    expect(registerSecret).toHaveBeenCalledWith('secret-token')
  })

  it('真实 CLI + 空路径：valid 报假并显示错误提示', async () => {
    const wrapper = mountCard({ source: 'cli', cliPath: '   ', token: 't' })
    await wrapper.vm.$nextTick()
    expect(wrapper.emitted('update:valid')).toEqual([[false]])
    expect(wrapper.find('.cc__alert').exists()).toBe(true)
  })

  it('路径齐全 / 模拟数据源：valid 报真且不显示错误', async () => {
    const ready = mountCard({ source: 'cli', cliPath: 'D:\\tools\\codehub-cli.exe', token: 't' })
    await ready.vm.$nextTick()
    expect(ready.emitted('update:valid')).toEqual([[true]])
    expect(ready.find('.cc__alert').exists()).toBe(false)

    const mock = mountCard({ source: 'mock' })
    await mock.vm.$nextTick()
    expect(mock.emitted('update:valid')).toEqual([[true]])
  })

  it('父级回写自己刚上抛的同值不再触发新一轮 push（防逐键打断输入）', async () => {
    const wrapper = mountCard({ source: 'cli', cliPath: 'p', token: 't' })
    await edit(wrapper, { source: 'cli', cliPath: 'p', token: 't', pullBatchLimit: 50 })
    expect(pushes(wrapper)).toHaveLength(1)

    await edit(wrapper, pushes(wrapper)[0])
    expect(pushes(wrapper)).toHaveLength(1)
  })
})
