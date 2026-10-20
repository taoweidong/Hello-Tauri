import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 消息中心中栏（时间线）测试。
 *
 * 存在的唯一理由：这里是全项目**最后一处**「模板内裸调 store 异步方法」的漏网点
 * （第五轮勘察）。读库失败时 store 只 `finally` 不 `catch`，异常一路冒到 `@click`
 * 变成未处理拒绝，界面既不提示、按钮也不复位 —— 用户看到的是「点了没反应」，
 * 且连点无效（store 侧的 in-flight 锁还压着）。
 */
vi.mock('element-plus', () => ({
  ElMessage: { success: vi.fn(), warning: vi.fn(), error: vi.fn() },
}))

import { ElMessage } from 'element-plus'
import TimelinePanel from './TimelinePanel.vue'
import type { WelinkJob, WelinkMessage } from '@/types/welink'

const loadEarlierMessages = vi.fn(async () => undefined)

const conversation = { pk: 1, convId: 'G-1', title: '核心业务群', convType: 'group' as const }

const message = (overrides: Partial<WelinkMessage> = {}): WelinkMessage =>
  ({
    pk: 1,
    convPk: 1,
    convId: 'G-1',
    msgUid: 'u1',
    direction: 'in',
    senderId: 's1',
    senderName: '张三',
    content: '在吗',
    msgType: 'text',
    atMe: false,
    readFlag: true,
    sentAt: '2026-10-20 10:00:00',
    createdAt: '2026-10-20 10:00:00',
    ...overrides,
  }) as WelinkMessage

const job = (overrides: Partial<WelinkJob> = {}): WelinkJob =>
  ({
    pk: 11,
    triggerMsgPk: 1,
    targetId: 'G-1',
    status: 'sent',
    attempts: 0,
    ...overrides,
  }) as WelinkJob

const state = {
  selectedConversation: null as typeof conversation | null,
  messages: [] as WelinkMessage[],
  convJobs: [] as WelinkJob[],
  hasMoreMessages: true,
}

vi.mock('@/stores/welink', () => ({
  useWelinkStore: () => ({
    get selectedConversation() {
      return state.selectedConversation
    },
    get messages() {
      return state.messages
    },
    get convJobs() {
      return state.convJobs
    },
    get hasMoreMessages() {
      return state.hasMoreMessages
    },
    statusLabel: (status: string) => `状态-${status}`,
    skipLabel: (reason: string) => `原因-${reason}`,
    loadEarlierMessages,
  }),
}))

function mountPanel() {
  return mount(TimelinePanel, {
    props: { showRight: true },
    global: {
      stubs: {
        'el-button': { template: '<button class="btn-stub" @click="$emit(\'click\')"><slot /></button>' },
      },
    },
  })
}

beforeEach(() => {
  state.selectedConversation = conversation
  state.messages = [message()]
  state.convJobs = []
  state.hasMoreMessages = true
  loadEarlierMessages.mockReset()
  loadEarlierMessages.mockResolvedValue(undefined)
  vi.mocked(ElMessage.error).mockClear()
})

describe('components/welink/messages/TimelinePanel', () => {
  it('点「加载更早的消息」真的调 store（不是死按钮）', async () => {
    const wrapper = mountPanel()
    await wrapper.get('.mc__load-earlier').trigger('click')
    await flushPromises()

    expect(loadEarlierMessages).toHaveBeenCalledTimes(1)
    expect(ElMessage.error).not.toHaveBeenCalled()
  })

  it('读库失败必须提示（此前是未处理拒绝 + 界面零反馈）', async () => {
    loadEarlierMessages.mockRejectedValueOnce(new Error('库挂了'))
    const wrapper = mountPanel()

    await wrapper.get('.mc__load-earlier').trigger('click')
    await flushPromises()

    expect(ElMessage.error).toHaveBeenCalledWith('库挂了')
    // busy 必须复位：否则按钮一直禁用，用户连重试的机会都没有
    expect((wrapper.get('.mc__load-earlier').element as HTMLButtonElement).disabled).toBe(false)
    expect(wrapper.text()).toContain('加载更早的消息')
  })

  it('加载中禁用按钮并给出在飞文案（防连点 + 有反馈）', async () => {
    let release!: () => void
    loadEarlierMessages.mockImplementationOnce(
      () =>
        new Promise<undefined>((resolve) => {
          release = () => resolve(undefined)
        }),
    )
    const wrapper = mountPanel()

    void wrapper.get('.mc__load-earlier').trigger('click')
    await flushPromises()

    expect((wrapper.get('.mc__load-earlier').element as HTMLButtonElement).disabled).toBe(true)
    expect(wrapper.text()).toContain('加载中…')

    release()
    await flushPromises()
    expect((wrapper.get('.mc__load-earlier').element as HTMLButtonElement).disabled).toBe(false)
  })

  it('无更多消息时不显示按钮（走到最早）', () => {
    state.hasMoreMessages = false
    const wrapper = mountPanel()
    expect(wrapper.find('.mc__load-earlier').exists()).toBe(false)
    expect(wrapper.text()).toContain('已到最早')
  })

  it('消息下方内联回复状态微条：点击上报跳转意图', async () => {
    state.convJobs = [job({ triggerMsgPk: 1, targetId: 'G-1', status: 'failed', attempts: 2 })]
    const wrapper = mountPanel()

    expect(wrapper.text()).toContain('状态-failed')
    await wrapper.get('.bubble__job').trigger('click')
    expect(wrapper.emitted('open-history')?.[0]).toEqual(['G-1'])
  })
})
