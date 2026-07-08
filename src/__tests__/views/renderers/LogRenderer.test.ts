import { describe, it, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import LogRenderer from '@/views/renderers/LogRenderer.vue'
import type { LogLine } from '@/types'

vi.mock('@/composables/use-tabs', () => ({
  useTabManager: () => ({ setCursor: vi.fn(), globalFontSize: 13 }),
}))

describe('LogRenderer', () => {
  const mockContent: LogLine[] = [
    {
      lineNumber: 1,
      timestamp: '2024-01-01 00:00:00',
      level: 'INFO',
      module: 'app',
      message: '启动',
      raw: 'INFO app 启动',
    },
    {
      lineNumber: 2,
      timestamp: '2024-01-01 00:00:01',
      level: 'ERROR',
      module: 'db',
      message: '连接失败',
      raw: 'ERROR db 连接失败',
    },
  ]

  it('空日志时显示空提示', () => {
    const wrapper = mount(LogRenderer, {
      props: { content: [] },
    })
    expect(wrapper.text()).toContain('空日志')
  })

  it('有日志时渲染 DataTable', async () => {
    const wrapper = mount(LogRenderer, {
      props: { content: mockContent },
    })
    await nextTick()
    expect(wrapper.text()).not.toContain('空日志')
    expect(wrapper.findComponent({ name: 'DataTable' }).exists()).toBe(true)
  })

  it('不渲染原始 div 列表', async () => {
    const wrapper = mount(LogRenderer, {
      props: { content: mockContent },
    })
    await nextTick()
    expect(wrapper.find('.log-renderer').exists()).toBe(false)
    expect(wrapper.find('.log-line').exists()).toBe(false)
  })
})
