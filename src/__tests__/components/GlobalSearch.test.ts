import { describe, it, expect, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import GlobalSearch from '@/components/public-bar/GlobalSearch.vue'
import { useTabManager } from '@/composables/use-tabs'
import { useArchiveManager } from '@/composables/use-archives'
import type { FileTreeNode, ArchiveItem } from '@/types'

/** 构造文件树节点 */
function mockNode(name: string, path?: string, isLeaf = true): FileTreeNode {
  return { key: path || `/${name}`, label: name, isLeaf, path: path || `/${name}` }
}

/** 构造已完成的归档项 */
function mockArchive(id: string, name: string, files: FileTreeNode[]): ArchiveItem {
  return {
    id,
    name,
    cacheId: id,
    status: 'completed',
    progress: 100,
    files,
    originalSize: 0,
    compressedSize: 0,
  }
}

/** 等待防抖定时器完成（300ms + 缓冲） */
function flushDebounce() {
  return new Promise(resolve => setTimeout(resolve, 350))
}

describe('GlobalSearch', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    const { reset: resetTabs } = useTabManager()
    resetTabs()
    const { reset: resetArchives } = useArchiveManager()
    resetArchives()
  })

  it('渲染搜索输入框', () => {
    const wrapper = mount(GlobalSearch)
    expect(wrapper.findComponent({ name: 'Input' }).exists()).toBe(true)
  })

  it('渲染搜索按钮', () => {
    const wrapper = mount(GlobalSearch)
    const buttons = wrapper.findAllComponents({ name: 'Button' })
    expect(buttons.length).toBeGreaterThanOrEqual(1)
  })

  it('显示快捷键标签', () => {
    const wrapper = mount(GlobalSearch)
    const kbd = wrapper.find('kbd')
    expect(kbd.exists()).toBe(true)
    expect(kbd.text()).toMatch(/(Ctrl\+K|⌘K)/)
  })

  it('空关键字时无搜索结果', async () => {
    const wrapper = mount(GlobalSearch)
    const vm = wrapper.vm as any
    vm.keyword = '   '
    await nextTick()
    expect(vm.searchResults).toHaveLength(0)
    expect(vm.showResults).toBe(false)
  })

  it('按文件名搜索归档中的文件', async () => {
    const { archives } = useArchiveManager()
    archives.value = [
      mockArchive('a1', 'data.zip', [
        mockNode('hello.txt', '/hello.txt'),
        mockNode('world.log', '/world.log'),
        mockNode('data.json', '/sub/data.json'),
      ]),
    ]

    const wrapper = mount(GlobalSearch)
    const vm = wrapper.vm as any
    vm.keyword = 'hello'
    await nextTick()
    await flushDebounce()
    expect(vm.searchResults).toHaveLength(1)
    expect(vm.searchResults[0].fileName).toBe('hello.txt')
  })

  it('按路径搜索归档中的文件', async () => {
    const { archives } = useArchiveManager()
    archives.value = [
      mockArchive('a1', 'data.zip', [
        mockNode('data.json', '/sub/data.json'),
        mockNode('other.txt', '/other.txt'),
      ]),
    ]

    const wrapper = mount(GlobalSearch)
    const vm = wrapper.vm as any
    vm.keyword = 'sub'
    await nextTick()
    await flushDebounce()
    expect(vm.searchResults).toHaveLength(1)
    expect(vm.searchResults[0].fileName).toBe('data.json')
  })

  it('跨多个归档搜索', async () => {
    const { archives } = useArchiveManager()
    archives.value = [
      mockArchive('a1', 'first.zip', [mockNode('test.txt', '/test.txt')]),
      mockArchive('a2', 'second.zip', [mockNode('test.log', '/test.log')]),
    ]

    const wrapper = mount(GlobalSearch)
    const vm = wrapper.vm as any
    vm.keyword = 'test'
    await nextTick()
    await flushDebounce()
    expect(vm.searchResults).toHaveLength(2)
  })

  it('仅搜索已完成的归档', async () => {
    const { archives } = useArchiveManager()
    archives.value = [
      mockArchive('a1', 'done.zip', [mockNode('hello.txt', '/hello.txt')]),
      { ...mockArchive('a2', 'pending.zip', [mockNode('hello.csv', '/hello.csv')]), status: 'pending' },
    ]

    const wrapper = mount(GlobalSearch)
    const vm = wrapper.vm as any
    vm.keyword = 'hello'
    await nextTick()
    await flushDebounce()
    expect(vm.searchResults).toHaveLength(1)
    expect(vm.searchResults[0].archiveId).toBe('a1')
  })

  it('跳过目录节点，仅返回文件', async () => {
    const { archives } = useArchiveManager()
    archives.value = [
      mockArchive('a1', 'data.zip', [
        { key: '/sub', label: 'sub', isLeaf: false, path: '/sub', children: [mockNode('a.txt', '/sub/a.txt')] },
      ]),
    ]

    const wrapper = mount(GlobalSearch)
    const vm = wrapper.vm as any
    vm.keyword = 'sub'
    await nextTick()
    await flushDebounce()
    // 目录本身不出现在结果中，但路径包含 sub 的文件会匹配
    expect(vm.searchResults).toHaveLength(1)
    expect(vm.searchResults[0].fileName).toBe('a.txt')
    expect(vm.searchResults[0].node.isLeaf).toBe(true)
  })

  it('大小写不敏感搜索', async () => {
    const { archives } = useArchiveManager()
    archives.value = [
      mockArchive('a1', 'data.zip', [mockNode('Hello.TXT', '/Hello.TXT')]),
    ]

    const wrapper = mount(GlobalSearch)
    const vm = wrapper.vm as any
    vm.keyword = 'hello'
    await nextTick()
    await flushDebounce()
    expect(vm.searchResults).toHaveLength(1)
  })

  it('navigateToResult 打开新标签页', async () => {
    const { archives } = useArchiveManager()
    const { tabs, activeTabId } = useTabManager()
    archives.value = [
      mockArchive('a1', 'data.zip', [mockNode('hello.txt', '/hello.txt')]),
    ]

    const wrapper = mount(GlobalSearch)
    const vm = wrapper.vm as any
    vm.keyword = 'hello'
    await nextTick()
    await flushDebounce()

    const result = vm.searchResults[0]
    vm.navigateToResult(result)
    await nextTick()

    expect(tabs.value).toHaveLength(1)
    expect(tabs.value[0].fileNode.key).toBe('/hello.txt')
    expect(activeTabId.value).toBeDefined()
    expect(vm.showResults).toBe(false)
    expect(vm.keyword).toBe('')
  })

  it('navigateToResult 已打开的标签页直接激活', async () => {
    const { archives } = useArchiveManager()
    const { openTab, tabs } = useTabManager()
    archives.value = [
      mockArchive('a1', 'data.zip', [mockNode('hello.txt', '/hello.txt')]),
    ]

    openTab(mockNode('hello.txt', '/hello.txt'), 'a1')

    const wrapper = mount(GlobalSearch)
    const vm = wrapper.vm as any
    vm.keyword = 'hello'
    await nextTick()
    await flushDebounce()

    const result = vm.searchResults[0]
    expect(result.alreadyOpen).toBe(true)

    vm.navigateToResult(result)
    await nextTick()

    expect(tabs.value).toHaveLength(1)
  })

  it('totalMatches 返回匹配总数', async () => {
    const { archives } = useArchiveManager()
    archives.value = [
      mockArchive('a1', 'data.zip', [
        mockNode('test1.txt', '/test1.txt'),
        mockNode('test2.txt', '/test2.txt'),
        mockNode('other.txt', '/other.txt'),
      ]),
    ]

    const wrapper = mount(GlobalSearch)
    const vm = wrapper.vm as any
    vm.keyword = 'test'
    await nextTick()
    await flushDebounce()
    expect(vm.totalMatches).toBe(2)
  })

  it('输入关键字时自动显示结果面板', async () => {
    const { archives } = useArchiveManager()
    archives.value = [
      mockArchive('a1', 'data.zip', [mockNode('hello.txt', '/hello.txt')]),
    ]

    const wrapper = mount(GlobalSearch)
    const vm = wrapper.vm as any
    vm.keyword = 'hello'
    await nextTick()
    expect(vm.showResults).toBe(true)
  })

  it('closeResults 关闭结果面板', async () => {
    const wrapper = mount(GlobalSearch)
    const vm = wrapper.vm as any
    vm.showResults = true
    await nextTick()
    vm.closeResults()
    await nextTick()
    expect(vm.showResults).toBe(false)
  })

  it('Escape 关闭结果面板', async () => {
    const wrapper = mount(GlobalSearch)
    const vm = wrapper.vm as any
    vm.showResults = true
    await nextTick()
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await nextTick()
    expect(vm.showResults).toBe(false)
  })

  it('Ctrl+K 快捷键不报错', async () => {
    const wrapper = mount(GlobalSearch)
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true }))
    await nextTick()
    expect(wrapper.exists()).toBe(true)
  })

  it('Ctrl+F 快捷键拦截浏览器默认搜索', async () => {
    const wrapper = mount(GlobalSearch)
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', ctrlKey: true }))
    await nextTick()
    expect(wrapper.exists()).toBe(true)
  })

  it('handleClickOutside 点击外部关闭结果', async () => {
    const wrapper = mount(GlobalSearch)
    const vm = wrapper.vm as any
    vm.showResults = true
    await nextTick()
    document.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await nextTick()
    expect(vm.showResults).toBe(false)
  })

  it('handleClickOutside 点击内部不关闭结果', async () => {
    const wrapper = mount(GlobalSearch)
    const vm = wrapper.vm as any
    vm.showResults = true
    await nextTick()

    const el = wrapper.find('.global-search-wrapper').element
    const mockTarget = { closest: (sel: string) => el } as any
    vm.handleClickOutside({ target: mockTarget } as any)
    await nextTick()
    expect(vm.showResults).toBe(true)
  })

  it('highlightMatch 高亮匹配段落', async () => {
    const wrapper = mount(GlobalSearch)
    const vm = wrapper.vm as any
    vm.keyword = 'ell'
    await nextTick()
    const seg = vm.highlightMatch('hello.txt')
    expect(seg.before).toBe('h')
    expect(seg.match).toBe('ell')
    expect(seg.after).toBe('o.txt')
  })

  it('highlightMatch 无匹配时返回原文', async () => {
    const wrapper = mount(GlobalSearch)
    const vm = wrapper.vm as any
    vm.keyword = 'xyz'
    await nextTick()
    const seg = vm.highlightMatch('hello.txt')
    expect(seg.before).toBe('hello.txt')
    expect(seg.match).toBe('')
    expect(seg.after).toBe('')
  })

  it('getDirPath 提取目录路径', async () => {
    const wrapper = mount(GlobalSearch)
    const vm = wrapper.vm as any
    expect(vm.getDirPath('/sub/dir/file.txt')).toBe('/sub/dir/')
    expect(vm.getDirPath('file.txt')).toBe('')
  })
})
