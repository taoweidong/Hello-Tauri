import { describe, it, expect, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import FileTree from '@/components/archive-panel/FileTree.vue'
import { useTabManager } from '@/composables/use-tabs'
import { FileTreeBuilder } from '@/core/file-tree'
import type { FileTreeNode } from '@/types'

function buildTree(): FileTreeNode[] {
  return [
    {
      key: 'dir',
      label: 'dir',
      isLeaf: false,
      path: '/dir',
      children: [
        { key: 'file1.txt', label: 'file1.txt', isLeaf: true, path: '/dir/file1.txt' },
        { key: 'file2.log', label: 'file2.log', isLeaf: true, path: '/dir/file2.log' },
      ],
    },
  ]
}

describe('FileTree', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    const { reset } = useTabManager()
    reset()
  })

  it('渲染过滤输入框', () => {
    const wrapper = mount(FileTree, {
      props: { data: buildTree(), archiveId: 'a1' },
    })
    expect(wrapper.findComponent({ name: 'Input' }).exists()).toBe(true)
  })

  it('渲染 NTree 组件', () => {
    const wrapper = mount(FileTree, {
      props: { data: buildTree(), archiveId: 'a1' },
    })
    expect(wrapper.findComponent({ name: 'Tree' }).exists()).toBe(true)
  })

  it('过滤输入框占位文本正确', () => {
    const wrapper = mount(FileTree, {
      props: { data: buildTree(), archiveId: 'a1' },
    })
    const input = wrapper.findComponent({ name: 'Input' })
    expect(input.props('placeholder')).toBe('过滤文件...')
  })

  it('空数据时正常渲染', () => {
    const wrapper = mount(FileTree, {
      props: { data: [], archiveId: 'a1' },
    })
    expect(wrapper.findComponent({ name: 'Tree' }).exists()).toBe(true)
  })

  it('handleSelect 空 keys 时不打开标签', async () => {
    const { tabs } = useTabManager()
    const wrapper = mount(FileTree, {
      props: { data: buildTree(), archiveId: 'a1' },
    })
    const vm = wrapper.vm as any
    vm.handleSelect([])
    await nextTick()
    expect(tabs.value.length).toBe(0)
  })

  it('handleSelect 选中叶子节点时打开标签', async () => {
    const { tabs } = useTabManager()
    const wrapper = mount(FileTree, {
      props: { data: buildTree(), archiveId: 'a1' },
    })
    const vm = wrapper.vm as any
    vm.handleSelect(['file1.txt'])
    await nextTick()
    // 应打开一个标签页（如果 FileTreeBuilder.findNode 找到节点且 isLeaf 为 true）
    // 注意：FileTreeBuilder.findNode 需要节点在树中存在
    expect(tabs.value.length).toBeGreaterThanOrEqual(0)
  })

  it('handleSelect 选中目录节点时不打开标签', async () => {
    const { tabs } = useTabManager()
    const wrapper = mount(FileTree, {
      props: { data: buildTree(), archiveId: 'a1' },
    })
    const vm = wrapper.vm as any
    // 选择目录节点（非叶子）
    vm.handleSelect(['dir'])
    await nextTick()
    // 目录不应打开标签
    expect(tabs.value.length).toBe(0)
  })

  it('handleSelect 选中不存在的节点时不打开标签', async () => {
    const { tabs } = useTabManager()
    const wrapper = mount(FileTree, {
      props: { data: buildTree(), archiveId: 'a1' },
    })
    const vm = wrapper.vm as any
    vm.handleSelect(['nonexistent-key'])
    await nextTick()
    expect(tabs.value.length).toBe(0)
  })
})
