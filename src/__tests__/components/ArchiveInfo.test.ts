import { describe, it, expect, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import ArchiveInfo from '@/components/property-panel/ArchiveInfo.vue'
import { useTabManager } from '@/composables/use-tabs'
import { useArchiveManager } from '@/composables/use-archives'
import type { FileTreeNode, ArchiveItem } from '@/types'

function mockNode(name: string): FileTreeNode {
  return { key: name, label: name, isLeaf: true, path: `/${name}` }
}

describe('ArchiveInfo', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    const { reset } = useTabManager()
    reset()
    const { reset: resetArchives } = useArchiveManager()
    resetArchives()
  })

  it('无活动标签时显示"未选择压缩包"', () => {
    const wrapper = mount(ArchiveInfo)
    expect(wrapper.text()).toContain('未选择压缩包')
  })

  it('有活动标签且归档匹配时渲染描述列表', async () => {
    const { addFiles } = useArchiveManager()
    const zipFile = new File(['fake-zip'], 'test.zip', { type: 'application/zip' })
    addFiles([zipFile])
    await nextTick()

    const { archives } = useArchiveManager()
    const { openTab } = useTabManager()
    openTab(mockNode('file.txt'), archives.value[0].id)
    await nextTick()

    const wrapper = mount(ArchiveInfo)
    await nextTick()
    expect(wrapper.findComponent({ name: 'Descriptions' }).exists()).toBe(true)
  })

  it('状态标签显示中文', async () => {
    const { addFiles } = useArchiveManager()
    const zipFile = new File(['content'], 'sample.zip', { type: 'application/zip' })
    addFiles([zipFile])
    await nextTick()

    const { archives } = useArchiveManager()
    const { openTab } = useTabManager()
    openTab(mockNode('file.txt'), archives.value[0].id)
    await nextTick()

    const wrapper = mount(ArchiveInfo)
    await nextTick()
    expect(wrapper.text()).toContain('等待中')
  })

  it('已完成状态显示"已完成"标签', async () => {
    const { addFiles, archives } = useArchiveManager()
    const zipFile = new File(['content-done'], 'done.zip', { type: 'application/zip' })
    addFiles([zipFile])
    await nextTick()

    // 手动修改状态为 completed
    archives.value[0].status = 'completed'
    archives.value[0].originalSize = 2048
    await nextTick()

    const { openTab } = useTabManager()
    openTab(mockNode('file.txt'), archives.value[0].id)
    await nextTick()

    const wrapper = mount(ArchiveInfo)
    await nextTick()
    expect(wrapper.text()).toContain('已完成')
    // originalSize > 0 应显示原始大小
    expect(wrapper.text()).toContain('原始大小')
  })

  it('有解压耗时时显示耗时信息', async () => {
    const { addFiles, archives } = useArchiveManager()
    const zipFile = new File(['content-time'], 'time.zip', { type: 'application/zip' })
    addFiles([zipFile])
    await nextTick()

    // 设置 startTime 和 endTime
    archives.value[0].startTime = Date.now() - 5000
    archives.value[0].endTime = Date.now()
    archives.value[0].status = 'completed'
    await nextTick()

    const { openTab } = useTabManager()
    openTab(mockNode('file.txt'), archives.value[0].id)
    await nextTick()

    const wrapper = mount(ArchiveInfo)
    await nextTick()
    expect(wrapper.text()).toContain('解压耗时')
  })

  it('包含 VERSION.txt 时显示版本信息', async () => {
    const { addFiles, archives } = useArchiveManager()
    const zipFile = new File(['content-ver'], 'ver.zip', { type: 'application/zip' })
    addFiles([zipFile])
    await nextTick()

    // 添加 VERSION.txt 文件节点
    archives.value[0].files = [
      { key: '/VERSION.txt', label: 'VERSION.txt', isLeaf: true, path: '/VERSION.txt', size: 100 },
      { key: '/data.txt', label: 'data.txt', isLeaf: true, path: '/data.txt', size: 500 },
    ]
    await nextTick()

    const { openTab } = useTabManager()
    openTab(mockNode('file.txt'), archives.value[0].id)
    await nextTick()

    const wrapper = mount(ArchiveInfo)
    await nextTick()
    expect(wrapper.text()).toContain('版本文件')
  })

  it('running 状态显示"解压中"', async () => {
    const { addFiles, archives } = useArchiveManager()
    const zipFile = new File(['content-run'], 'run.zip', { type: 'application/zip' })
    addFiles([zipFile])
    await nextTick()

    archives.value[0].status = 'running'
    await nextTick()

    const { openTab } = useTabManager()
    openTab(mockNode('file.txt'), archives.value[0].id)
    await nextTick()

    const wrapper = mount(ArchiveInfo)
    await nextTick()
    expect(wrapper.text()).toContain('解压中')
  })

  it('failed 状态显示"失败"', async () => {
    const { addFiles, archives } = useArchiveManager()
    const zipFile = new File(['content-fail'], 'fail.zip', { type: 'application/zip' })
    addFiles([zipFile])
    await nextTick()

    archives.value[0].status = 'failed'
    archives.value[0].error = '解压失败'
    await nextTick()

    const { openTab } = useTabManager()
    openTab(mockNode('file.txt'), archives.value[0].id)
    await nextTick()

    const wrapper = mount(ArchiveInfo)
    await nextTick()
    expect(wrapper.text()).toContain('失败')
  })

  it('归档 ID 不匹配时显示"未选择压缩包"', async () => {
    const { addFiles } = useArchiveManager()
    addFiles([new File(['x'], 'a.zip', { type: 'application/zip' })])
    await nextTick()

    const { openTab } = useTabManager()
    // 使用一个不存在的归档 ID
    openTab(mockNode('file.txt'), 'nonexistent-archive-id')
    await nextTick()

    const wrapper = mount(ArchiveInfo)
    await nextTick()
    expect(wrapper.text()).toContain('未选择压缩包')
  })
})
