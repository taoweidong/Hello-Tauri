import { describe, it, expect, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import TextRenderer from '@/views/renderers/TextRenderer.vue'
import { useTabManager } from '@/composables/use-tabs'

describe('TextRenderer', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    const { reset } = useTabManager()
    reset()
  })

  it('空内容时渲染 NEmpty', () => {
    const wrapper = mount(TextRenderer, {
      props: { content: '' },
    })
    expect(wrapper.text()).toContain('空文件')
  })

  it('有内容时渲染行号', () => {
    const wrapper = mount(TextRenderer, {
      props: { content: '第一行\n第二行\n第三行' },
    })
    const lines = wrapper.findAll('.line')
    expect(lines.length).toBe(3)
    expect(lines[0].find('.line-no').text()).toBe('1')
    expect(lines[1].find('.line-no').text()).toBe('2')
    expect(lines[2].find('.line-no').text()).toBe('3')
  })

  it('有内容时渲染行文本', () => {
    const wrapper = mount(TextRenderer, {
      props: { content: 'hello world' },
    })
    expect(wrapper.find('.line-text').text()).toBe('hello world')
  })

  it('点击行调用 setCursor 设置光标位置', async () => {
    const wrapper = mount(TextRenderer, {
      props: { content: 'line1\nline2' },
    })
    const { cursorPosition } = useTabManager()

    const line = wrapper.findAll('.line')[1]
    // 模拟点击第二行
    await line.trigger('click', { clientX: 50 })

    // 光标应更新
    expect(cursorPosition.value.line).toBeGreaterThanOrEqual(1)
  })

  it('单行文本只渲染一行', () => {
    const wrapper = mount(TextRenderer, {
      props: { content: 'only one line' },
    })
    expect(wrapper.findAll('.line').length).toBe(1)
  })
})
