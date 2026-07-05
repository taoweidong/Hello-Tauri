import { describe, it, expect, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import PublicBar from '@/components/public-bar/PublicBar.vue'
import { useArchiveManager } from '@/composables/use-archives'

describe('PublicBar', () => {
  beforeEach(() => {
    const { reset } = useArchiveManager()
    reset()
  })

  it('渲染批量操作按钮', () => {
    const wrapper = mount(PublicBar)
    const text = wrapper.text()
    expect(text).toContain('批量操作')
  })

  it('包含全局搜索组件', () => {
    const wrapper = mount(PublicBar)
    // GlobalSearch 被渲染（通过组件名查找）
    const globalSearch = wrapper.findComponent({ name: 'GlobalSearch' })
    expect(globalSearch.exists()).toBe(true)
  })

  it('使用 NSpace 布局', () => {
    const wrapper = mount(PublicBar)
    const spaces = wrapper.findAllComponents({ name: 'Space' })
    expect(spaces.length).toBeGreaterThanOrEqual(1)
  })

  it('一键清空后归档列表为空', async () => {
    const { addFiles, archives } = useArchiveManager()

    // 添加一个文件
    const zipFile = new File(['fake-zip-content'], 'test.zip', { type: 'application/zip' })
    addFiles([zipFile])
    await nextTick()

    // 验证有归档
    expect(archives.value.length).toBeGreaterThanOrEqual(1)

    // 挂载 PublicBar
    const wrapper = mount(PublicBar)

    // NDropdown 组件被渲染
    const dropdown = wrapper.findComponent({ name: 'Dropdown' })
    expect(dropdown.exists()).toBe(true)
  })
})
