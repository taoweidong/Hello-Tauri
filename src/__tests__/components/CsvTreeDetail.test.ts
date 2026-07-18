import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import CsvTreeDetail from '@/views/renderers/CsvTreeDetail.vue'
import type { RowTreeNode } from '@/core/csv-row-tree'

/** 构造空树 */
function emptyTree(): RowTreeNode {
  return { key: 'root', isLeaf: false, children: [] }
}

/** 构造简单树：root 下 2 个叶子 */
function simpleTree(): RowTreeNode {
  return {
    key: 'root',
    isLeaf: false,
    children: [
      { key: 'name', value: 'Alice', isLeaf: true, valueType: 'string' },
      { key: 'age', value: 30, isLeaf: true, valueType: 'number' },
    ],
  }
}

/** 构造 a/b/c 三叶树 */
function abcTree(): RowTreeNode {
  return {
    key: 'root',
    isLeaf: false,
    children: [
      { key: 'a', value: '1', isLeaf: true, valueType: 'string' },
      { key: 'b', value: '2', isLeaf: true, valueType: 'string' },
      { key: 'c', value: '3', isLeaf: true, valueType: 'string' },
    ],
  }
}

/** 构造深层树：root → user → name（maxDepth = 3） */
function deepTree(): RowTreeNode {
  return {
    key: 'root',
    isLeaf: false,
    children: [
      {
        key: 'user',
        isLeaf: false,
        children: [
          { key: 'name', value: 'Alice', isLeaf: true, valueType: 'string' },
        ],
      },
    ],
  }
}

describe('CsvTreeDetail', () => {
  it('渲染空树显示 "空树"', () => {
    const wrapper = mount(CsvTreeDetail, {
      props: { tree: emptyTree() },
    })
    expect(wrapper.text()).toContain('空树')
  })

  it('渲染有内容的树显示节点 key', () => {
    const wrapper = mount(CsvTreeDetail, {
      props: { tree: simpleTree() },
    })
    // TreeNode 渲染叶子节点 key（带引号）
    expect(wrapper.text()).toContain('"name"')
    expect(wrapper.text()).toContain('"age"')
  })

  it('搜索筛选仅保留匹配项', async () => {
    const wrapper = mount(CsvTreeDetail, {
      props: { tree: abcTree() },
    })
    const vm = wrapper.vm as any
    vm.searchKeyword = 'b'
    await nextTick()
    const text = wrapper.text()
    expect(text).toContain('"b"')
    expect(text).not.toContain('"a"')
    expect(text).not.toContain('"c"')
  })

  it('搜索无匹配显示 "无匹配项"', async () => {
    const wrapper = mount(CsvTreeDetail, {
      props: { tree: abcTree() },
    })
    const vm = wrapper.vm as any
    vm.searchKeyword = 'xyz'
    await nextTick()
    expect(wrapper.text()).toContain('无匹配项')
  })

  it('点击全部展开按钮 expandedDepths 包含所有深度', async () => {
    const wrapper = mount(CsvTreeDetail, {
      props: { tree: deepTree() },
    })
    const buttons = wrapper.findAll('button')
    const expandBtn = buttons.find(b => b.text().includes('全部展开'))
    expect(expandBtn).toBeTruthy()
    await expandBtn!.trigger('click')
    const vm = wrapper.vm as any
    expect(vm.expandedDepths).toEqual(new Set([1, 2, 3]))
  })

  it('点击全部折叠按钮 expandedDepths 仅含 [1]', async () => {
    const wrapper = mount(CsvTreeDetail, {
      props: { tree: deepTree() },
    })
    const buttons = wrapper.findAll('button')
    const collapseBtn = buttons.find(b => b.text().includes('全部折叠'))
    expect(collapseBtn).toBeTruthy()
    await collapseBtn!.trigger('click')
    const vm = wrapper.vm as any
    expect(vm.expandedDepths).toEqual(new Set([1]))
  })

  it('按层级选择第 2 层 expandedDepths 为 {1, 2}', async () => {
    const wrapper = mount(CsvTreeDetail, {
      props: { tree: deepTree() },
    })
    const vm = wrapper.vm as any
    vm.applyLevel(2)
    await nextTick()
    expect(vm.expandedDepths).toEqual(new Set([1, 2]))
    expect(vm.selectedLevel).toBe(2)
  })

  it('点击关闭按钮触发 close 事件', async () => {
    const wrapper = mount(CsvTreeDetail, {
      props: { tree: simpleTree() },
    })
    const buttons = wrapper.findAll('button')
    const closeBtn = buttons.find(b => b.text().includes('✕'))
    expect(closeBtn).toBeTruthy()
    await closeBtn!.trigger('click')
    expect(wrapper.emitted('close')).toBeTruthy()
    expect(wrapper.emitted('close')!.length).toBe(1)
  })
})
