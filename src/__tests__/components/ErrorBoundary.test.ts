import { describe, it, expect } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { h, defineComponent, ref, computed, nextTick } from 'vue'
import { NResult, NButton } from 'naive-ui'
import ErrorBoundary from '@/components/shared/ErrorBoundary.vue'

describe('ErrorBoundary', () => {
  it('正常子组件直接渲染', () => {
    const wrapper = mount(ErrorBoundary, {
      slots: {
        default: h('div', { class: 'test-child' }, '正常内容'),
      },
    })
    expect(wrapper.find('.test-child').exists()).toBe(true)
    expect(wrapper.text()).toContain('正常内容')
  })

  it('子组件渲染时抛出错误被 onErrorCaptured 捕获', async () => {
    // 使用 computed 属性抛出错误，这样能在渲染阶段被 onErrorCaptured 捕获
    const BuggyComponent = defineComponent({
      setup() {
        const count = ref(0)
        const message = computed(() => {
          if (count.value === 0) {
            throw new Error('测试异常：组件渲染失败')
          }
          return '正常'
        })
        return () => h('div', message.value)
      },
    })

    // 使用 global config.errorHandler 来抑制 Vue 的警告
    const wrapper = mount(ErrorBoundary, {
      slots: {
        default: h(BuggyComponent),
      },
      global: {
        config: {
          errorHandler: () => {},
          warnHandler: () => {},
        },
      },
    })

    await nextTick()

    // 验证 NResult 被渲染
    expect(wrapper.text()).toContain('渲染异常')
    expect(wrapper.text()).toContain('测试异常：组件渲染失败')
  })

  it('显示重试按钮', async () => {
    const BuggyComponent = defineComponent({
      setup() {
        const count = ref(0)
        const message = computed(() => {
          if (count.value === 0) {
            throw new Error('测试异常')
          }
          return '正常'
        })
        return () => h('div', message.value)
      },
    })

    const wrapper = mount(ErrorBoundary, {
      slots: {
        default: h(BuggyComponent),
      },
      global: {
        config: {
          errorHandler: () => {},
          warnHandler: () => {},
        },
      },
    })

    await nextTick()

    // NButton 应该被渲染
    expect(wrapper.findComponent(NButton).exists()).toBe(true)
    expect(wrapper.text()).toContain('重试')
  })

  it('点击重试按钮清除错误状态', async () => {
    const BuggyComponent = defineComponent({
      setup() {
        const count = ref(0)
        const message = computed(() => {
          if (count.value === 0) {
            throw new Error('测试异常')
          }
          return '正常'
        })
        return () => h('div', message.value)
      },
    })

    const wrapper = mount(ErrorBoundary, {
      slots: {
        default: h(BuggyComponent),
      },
      global: {
        config: {
          errorHandler: () => {},
          warnHandler: () => {},
        },
      },
    })

    await nextTick()

    // 验证错误状态存在
    expect(wrapper.text()).toContain('渲染异常')

    // 点击重试 - 子组件重新渲染，再次抛出错误
    const retryBtn = wrapper.findComponent(NButton)
    await retryBtn.trigger('click')
    await nextTick()

    // 重试后仍显示错误（因为 BuggyComponent 会再次抛出）
    expect(wrapper.text()).toContain('渲染异常')
  })

  it('空 slot 也能正常渲染', () => {
    const wrapper = mount(ErrorBoundary)
    expect(wrapper.findComponent(NResult).exists()).toBe(false)
  })
})
