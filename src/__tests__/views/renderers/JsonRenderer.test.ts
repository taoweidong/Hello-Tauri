import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import JsonRenderer from '@/views/renderers/JsonRenderer.vue'

describe('JsonRenderer', () => {
  it('content 为 null 时渲染 NEmpty', () => {
    const wrapper = mount(JsonRenderer, {
      props: { content: null },
    })
    expect(wrapper.text()).toContain('空内容')
  })

  it('content 为 undefined 时渲染 NEmpty', () => {
    const wrapper = mount(JsonRenderer, {
      props: { content: undefined },
    })
    expect(wrapper.text()).toContain('空内容')
  })

  it('有数据时渲染 JsonNode', () => {
    const wrapper = mount(JsonRenderer, {
      props: { content: { key: 'value' } },
    })
    expect(wrapper.find('.json-renderer').exists()).toBe(true)
  })

  it('渲染字符串类型内容', () => {
    const wrapper = mount(JsonRenderer, {
      props: { content: 'hello' },
    })
    expect(wrapper.find('.json-renderer').exists()).toBe(true)
  })

  it('渲染数组类型内容', () => {
    const wrapper = mount(JsonRenderer, {
      props: { content: [1, 2, 3] },
    })
    expect(wrapper.find('.json-renderer').exists()).toBe(true)
  })
})
