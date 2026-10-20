import { mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'

/**
 * 消息中心左栏的可达性契约。
 *
 * 会话行本身是 `<button>`，行内「更多」不能再用 `<button>`（HTML 不允许嵌套）。
 * 之前它是纯 `<span>@click`：鼠标能点、键盘永远够不到 —— 暂停监控/静音/看历史
 * 这三个动作对纯键盘用户等于不存在。这里钉住 role/tabindex/Enter 转发。
 */
const store = {
  watchingConversations: [
    {
      pk: 1,
      convId: 'G-1001',
      convType: 'group',
      title: '值班群',
      lastMsgAt: '2026-10-20 09:00:00',
      mentionCount: 0,
      unreadCount: 0,
      muteUntil: '',
    },
  ],
  selectedConvId: '',
  convoStates: {},
  selectConversation: vi.fn(),
  loadConversations: vi.fn(),
  updateConversation: vi.fn(),
  muteConversation: vi.fn(),
}

vi.mock('@/stores/welink', () => ({ useWelinkStore: () => store }))
vi.mock('element-plus', () => ({ ElMessage: { error: vi.fn(), success: vi.fn() } }))

import ConversationListPanel from './ConversationListPanel.vue'

const EP_STUBS: Record<string, unknown> = {
  'el-dropdown': { template: '<div><slot /><slot name="dropdown" /></div>' },
  'el-dropdown-menu': { template: '<div><slot /></div>' },
  'el-dropdown-item': { template: '<div><slot /></div>' },
}

describe('welink/messages/ConversationListPanel（可达性）', () => {
  it('行内「更多」可聚焦、有可读名称，Enter 激活即转发 click 给下拉触发器', async () => {
    const wrapper = mount(ConversationListPanel, { global: { stubs: EP_STUBS as never } })
    const more = wrapper.find('.mc__more-btn')
    expect(more.attributes('role')).toBe('button')
    expect(more.attributes('tabindex')).toBe('0')
    expect(more.attributes('aria-label')).toBe('更多操作')

    const click = vi.spyOn(more.element as HTMLElement, 'click')
    await more.trigger('keydown', { key: 'Enter' })
    expect(click).toHaveBeenCalledTimes(1)
  })

  it('过滤框带可读名称（只有 placeholder 不够读屏识别）', () => {
    const wrapper = mount(ConversationListPanel, { global: { stubs: EP_STUBS as never } })
    expect(wrapper.find('input.mc__input').attributes('aria-label')).toBe('过滤监控会话')
  })
})
