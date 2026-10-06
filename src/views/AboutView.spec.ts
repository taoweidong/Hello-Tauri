import { mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'

import AboutView from './AboutView.vue'

/**
 * 关于页「构建信息」测试。
 *
 * Git 节点与打包时间是构建期常量（`__GIT_COMMIT__` / `__BUILD_TIME__`，
 * 真值逻辑见 `scripts/version-meta.mjs`），具体值随构建变化，所以只断言
 * **结构性契约**：行存在、值为 6 位提交哈希或「未提供」占位、时间格式合法。
 */

vi.mock('@/stores/app', () => ({
  useAppStore: () => ({
    settings: { title: '', description: '' },
    info: {
      name: 'Hello-Tauri',
      version: '0.1.0',
      tauriVersion: '2.9.0',
      platform: 'windows',
      arch: 'x86_64',
    },
  }),
}))

function mountView() {
  return mount(AboutView)
}

/** dt 与 dd 在 dl 中一一对应，按下标取某行的值 */
function valueOf(wrapper: ReturnType<typeof mountView>, label: string): string {
  const dts = wrapper.findAll('dt')
  const index = dts.findIndex((d) => d.text() === label)
  expect(index).toBeGreaterThanOrEqual(0)
  return wrapper.findAll('dd')[index].text()
}

describe('AboutView 应用信息卡', () => {
  it('版本行显示桥接层上报的版本号（兜底构建期常量）', () => {
    const wrapper = mountView()
    expect(valueOf(wrapper, '版本')).toBe('v0.1.0')
  })

  it('Git 节点行显示 6 位提交哈希，非 git 环境降级为未提供占位', () => {
    const wrapper = mountView()
    const commit = valueOf(wrapper, 'Git 节点')
    expect(commit === '-' || /^[0-9a-f]{6}$/.test(commit)).toBe(true)
  })

  it('打包时间行显示本地时区时间，构建期未注入时降级为未提供占位', () => {
    const wrapper = mountView()
    const buildTime = valueOf(wrapper, '打包时间')
    expect(buildTime === '-' || /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(buildTime)).toBe(true)
  })
})
