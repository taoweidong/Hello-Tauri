import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import JsonNode from '@/views/renderers/JsonNode.vue'

describe('JsonNode', () => {
  it('渲染字符串节点', () => {
    const wrapper = mount(JsonNode, {
      props: { node: 'hello' },
    })
    expect(wrapper.find('.json-string').text()).toContain('hello')
  })

  it('渲染数字节点', () => {
    const wrapper = mount(JsonNode, {
      props: { node: 42 },
    })
    expect(wrapper.find('.json-number').text()).toBe('42')
  })

  it('渲染布尔节点', () => {
    const wrapper = mount(JsonNode, {
      props: { node: true },
    })
    expect(wrapper.find('.json-boolean').text()).toBe('true')
  })

  it('渲染 null 节点', () => {
    const wrapper = mount(JsonNode, {
      props: { node: null },
    })
    expect(wrapper.find('.json-null').text()).toBe('null')
  })

  it('渲染对象节点并显示键名', () => {
    const wrapper = mount(JsonNode, {
      props: { node: { a: 1 }, name: 'root', defaultOpen: true },
    })
    expect(wrapper.find('.json-key').text()).toContain('root')
    expect(wrapper.find('.json-count').text()).toContain('1 项')
  })

  it('渲染数组节点并显示元素数', () => {
    const wrapper = mount(JsonNode, {
      props: { node: [1, 2, 3], defaultOpen: true },
    })
    expect(wrapper.find('.json-count').text()).toContain('3 项')
  })

  it('折叠时显示省略号', async () => {
    const wrapper = mount(JsonNode, {
      props: { node: { a: 1 }, defaultOpen: false },
    })
    // 折叠状态下应显示 ...
    expect(wrapper.text()).toContain('...')
  })

  it('点击切换按钮展开/折叠', async () => {
    const wrapper = mount(JsonNode, {
      props: { node: { a: 1 }, defaultOpen: true },
    })
    const toggle = wrapper.find('.toggle')
    expect(toggle.exists()).toBe(true)
    // 初始展开
    expect(wrapper.find('.children').exists()).toBe(true)
    // 点击折叠
    await toggle.trigger('click')
    expect(wrapper.find('.children').exists()).toBe(false)
    // 再次点击展开
    await toggle.trigger('click')
    expect(wrapper.find('.children').exists()).toBe(true)
  })

  it('无 name 时不渲染键名', () => {
    const wrapper = mount(JsonNode, {
      props: { node: 'value' },
    })
    expect(wrapper.find('.json-key').exists()).toBe(false)
  })

  it('嵌套对象递归渲染', () => {
    const wrapper = mount(JsonNode, {
      props: { node: { inner: { deep: 'val' } }, defaultOpen: true },
    })
    // 应有嵌套的 JsonNode 子组件
    const nodes = wrapper.findAllComponents(JsonNode)
    expect(nodes.length).toBeGreaterThan(1)
  })

  it('嵌套数组递归渲染', () => {
    const wrapper = mount(JsonNode, {
      props: { node: [1, [2, 3]], defaultOpen: true },
    })
    const nodes = wrapper.findAllComponents(JsonNode)
    expect(nodes.length).toBeGreaterThan(1)
  })
})
