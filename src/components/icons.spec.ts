import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'

import { AppIcon, IconGrid } from './icons'

/**
 * 内联图标系统（运行时零外部请求）的契约。
 *
 * 图标是纯 SVG：必须带 viewBox、跟随 currentColor、且对读屏隐藏（装饰性）。
 * AppIcon 的动态缓存只是性能优化，不应改变渲染结构。
 */
describe('components/icons（内联 SVG）', () => {
  it('固定图标：渲染 24×24 描边 SVG 且 aria-hidden', () => {
    const wrapper = mount(IconGrid)
    const svg = wrapper.find('svg')
    expect(svg.attributes('viewBox')).toBe('0 0 24 24')
    expect(svg.attributes('fill')).toBe('none')
    expect(svg.attributes('stroke')).toBe('currentColor')
    expect(svg.attributes('aria-hidden')).toBe('true')
    expect(svg.element.children.length).toBeGreaterThan(0)
  })

  it('size 生效：显式传入时宽高跟随（默认 1em 跟随字号）', () => {
    const fallback = mount(IconGrid)
    expect(fallback.find('svg').attributes('width')).toBe('1em')
    const sized = mount(IconGrid, { props: { size: 20 } })
    expect(sized.find('svg').attributes('width')).toBe('20')
    expect(sized.find('svg').attributes('height')).toBe('20')
  })

  it('AppIcon：按 name 动态渲染，重复使用走缓存但结构一致', () => {
    const first = mount(AppIcon, { props: { name: 'grid' } })
    const second = mount(AppIcon, { props: { name: 'search' } })
    expect(first.find('svg').exists()).toBe(true)
    expect(first.find('svg').attributes('viewBox')).toBe('0 0 24 24')
    expect(second.find('svg').element.children.length).toBeGreaterThan(0)
    expect(second.html()).not.toBe(first.html())
  })
})
