import { describe, it, expect, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
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

  it('渲染所有日志行', () => {
    const wrapper = mount(LogRenderer, { props: { content: lines } })
    expect(wrapper.findAll('.log-line')).toHaveLength(4)
  })

  it('显示行号', () => {
    const wrapper = mount(LogRenderer, { props: { content: lines } })
    const nos = wrapper.findAll('.col-no').map(n => n.text())
    expect(nos).toEqual(['1', '2', '3', '4'])
  })

  it('INFO 级别应用蓝色', () => {
    const wrapper = mount(LogRenderer, { props: { content: lines } })
    const level = wrapper.findAll('.col-level')[0]
    expect(level.text()).toBe('INFO')
    expect(level.attributes('style')).toContain('color: rgb(59, 130, 246)')
  })

  it('ERROR 级别应用红色', () => {
    const wrapper = mount(LogRenderer, { props: { content: lines } })
    const level = wrapper.findAll('.col-level')[2]
    expect(level.text()).toBe('ERROR')
    expect(level.attributes('style')).toContain('color: rgb(239, 68, 68)')
  })

  it('OTHER 行显示 raw 而非 message', () => {
    const wrapper = mount(LogRenderer, { props: { content: lines } })
    const msg = wrapper.findAll('.col-msg')[3]
    expect(msg.text()).toBe('乱码行')
  })

  it('空日志显示 NEmpty', () => {
    const wrapper = mount(LogRenderer, { props: { content: [] } })
    expect(wrapper.text()).toContain('空日志')
  })

  it('点击日志行调用 setCursor 设置光标位置', async () => {
    setActivePinia(createPinia())
    const { reset, cursorPosition } = useTabManager()
    reset()
    const wrapper = mount(LogRenderer, { props: { content: lines } })
    const logLine = wrapper.findAll('.log-line')[1]
    await logLine.trigger('click')
    // 光标应更新为第 2 行
    expect(cursorPosition.value.line).toBe(2)
  })
})
