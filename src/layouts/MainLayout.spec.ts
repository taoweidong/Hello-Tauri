import { mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import { defineComponent } from 'vue'

import MainLayout from './MainLayout.vue'

/**
 * 侧栏底部版本行测试（版本 · git 节点 · 打包时间显示位置之一）。
 *
 * 版本元数据是构建期常量（`scripts/version-meta.mjs` 注入），测试只断言
 * 结构契约：`<平台>模式 · v<版本>[ · 6 位节点]`，悬停提示含打包时间。
 */

const push = vi.fn()

vi.mock('vue-router', () => ({
  useRoute: () => ({ path: '/', meta: { title: '工作台' } }),
  useRouter: () => ({ push }),
}))

// vue-router 被 mock 后 <router-view> 不再全局注册，用空渲染 stub 替身顶住
// （v-slot 的解构在 slot 未被调用时不会执行，避开「Component of undefined」）。
const RouterViewStub = defineComponent({ name: 'RouterView', setup: () => () => null })

function mountLayout() {
  return mount(MainLayout, { global: { components: { RouterView: RouterViewStub } } })
}

vi.mock('@/router', () => ({
  navGroups: () => [{ name: '总览', items: [{ path: '/', title: '工作台', icon: { render: () => null } }] }],
}))

vi.mock('@/stores/app', () => ({
  useAppStore: () => ({
    settings: { sidebarCollapsed: false, theme: 'light' },
    info: { name: 'Hello-Tauri', version: '0.1.0' },
  }),
}))

vi.mock('@/stores/welink', () => ({
  useWelinkStore: () => ({ unreadTotal: 0, reviewCount: 0 }),
}))

vi.mock('@/api', () => ({ platform: 'web' }))

describe('MainLayout 侧栏版本行', () => {
  it('底部显示 平台模式 · 版本号，有节点时追加 6 位提交哈希', () => {
    const wrapper = mountLayout()
    const env = wrapper.find('.rail__env')
    expect(env.exists()).toBe(true)
    expect(env.text()).toMatch(/^Web模式 · v0\.1\.0( · [0-9a-f]{6})?$/)
  })

  it('悬停提示含打包时间（本地时区），被截断时仍可从 tooltip 获取完整信息', () => {
    const wrapper = mountLayout()
    expect(wrapper.find('.rail__env').attributes('title')).toMatch(
      /版本 v0\.1\.0( · [0-9a-f]{6})? · 打包于 \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/,
    )
  })
})
