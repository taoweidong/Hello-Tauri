import { describe, it, expect, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'
import LogRenderer from '@/views/renderers/LogRenderer.vue'
import { useTabManager } from '@/composables/use-tabs'
import type { LogLine } from '@/plugins/parsers/types'

describe('LogRenderer', () => {
  const lines: LogLine[] = [
    { lineNumber: 1, timestamp: '2026-06-30 12:00:00', level: 'INFO', module: 'main', message: '应用启动', raw: '原始1' },
    { lineNumber: 2, timestamp: '2026-06-30 12:00:10', level: 'WARN', module: 'auth', message: '登录失败', raw: '原始2' },
    { lineNumber: 3, timestamp: '2026-06-30 12:00:30', level: 'ERROR', module: 'api', message: '404', raw: '原始3' },
    { lineNumber: 4, timestamp: '', level: 'OTHER', module: '', message: '', raw: '乱码行' },
  ]

  it('渲染 DataTable 组件', async () => {
    const wrapper = mount(LogRenderer, { props: { content: lines } })
    await nextTick()
    expect(wrapper.findComponent({ name: 'DataTable' }).exists()).toBe(true)
  })

  it('不再渲染旧式 .log-line 元素', async () => {
    const wrapper = mount(LogRenderer, { props: { content: lines } })
    await nextTick()
    expect(wrapper.findAll('.log-line')).toHaveLength(0)
  })

  it('空日志显示 NEmpty', () => {
    const wrapper = mount(LogRenderer, { props: { content: [] } })
    expect(wrapper.text()).toContain('空日志')
  })

  it('DataTable 接收 onRowClick prop', async () => {
    const wrapper = mount(LogRenderer, { props: { content: lines } })
    await nextTick()
    const dt = wrapper.findComponent({ name: 'DataTable' })
    expect(dt.exists()).toBe(true)
    // DataTable 应接收到 onRowClick 回调
    expect(dt.props('onRowClick')).toBeDefined()
  })

  it('有日志时不显示空提示', async () => {
    const wrapper = mount(LogRenderer, { props: { content: lines } })
    await nextTick()
    expect(wrapper.text()).not.toContain('空日志')
  })

  it('行点击触发 setCursor（通过 DataTable onRowClick）', async () => {
    setActivePinia(createPinia())
    const { reset, cursorPosition } = useTabManager()
    reset()
    const wrapper = mount(LogRenderer, { props: { content: lines } })
    await nextTick()
    // 获取 DataTable 的 onRowClick 回调并调用
    const dt = wrapper.findComponent({ name: 'DataTable' })
    const onClick = dt.props('onRowClick') as Function
    onClick({ lineNumber: 3 })
    expect(cursorPosition.value.line).toBe(3)
  })
})
