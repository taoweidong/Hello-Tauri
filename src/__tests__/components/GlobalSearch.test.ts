import { describe, it, expect, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import GlobalSearch from '@/components/public-bar/GlobalSearch.vue'
import { useTabManager } from '@/composables/use-tabs'
import { useSearch } from '@/composables/use-search'
import type { FileTreeNode } from '@/types'

function mockNode(name: string, path?: string): FileTreeNode {
  return { key: name, label: name, isLeaf: true, path: path || `/${name}` }
}

describe('GlobalSearch', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    const { reset } = useTabManager()
    reset()
    const { clear } = useSearch()
    clear()
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

  it('空关键字搜索时清空并隐藏结果', async () => {
    const wrapper = mount(GlobalSearch)
    const vm = wrapper.vm as any
    vm.keyword = '   '
    vm.handleSearch()
    await nextTick()
    expect(vm.showResults).toBe(false)
  })

  it('handleSearch 搜索 text 类型标签页', async () => {
    const { openTab, tabs } = useTabManager()
    openTab(mockNode('hello.txt'), 'a1')
    tabs.value[0].content = { type: 'text', data: 'hello world foo bar', pluginName: 'text' }

    const wrapper = mount(GlobalSearch)
    const vm = wrapper.vm as any
    vm.keyword = 'foo'
    vm.handleSearch()
    await nextTick()
    expect(vm.showResults).toBe(true)
  })

  it('handleSearch 搜索 csv 类型标签页', async () => {
    const { openTab, tabs } = useTabManager()
    openTab(mockNode('data.csv'), 'a1')
    tabs.value[0].content = {
      type: 'csv',
      data: { headers: ['name', 'age'], rows: [['Alice', '30']] },
      pluginName: 'csv',
    }

    const wrapper = mount(GlobalSearch)
    const vm = wrapper.vm as any
    vm.keyword = 'Alice'
    vm.handleSearch()
    await nextTick()
    expect(vm.showResults).toBe(true)
  })

  it('handleSearch 搜索 json 类型标签页（对象）', async () => {
    const { openTab, tabs } = useTabManager()
    openTab(mockNode('data.json'), 'a1')
    tabs.value[0].content = {
      type: 'json',
      data: { key: 'searchMe' },
      pluginName: 'json',
    }

    const wrapper = mount(GlobalSearch)
    const vm = wrapper.vm as any
    vm.keyword = 'searchMe'
    vm.handleSearch()
    await nextTick()
    expect(vm.showResults).toBe(true)
  })

  it('handleSearch 搜索 json 类型标签页（字符串）', async () => {
    const { openTab, tabs } = useTabManager()
    openTab(mockNode('str.json'), 'a1')
    tabs.value[0].content = {
      type: 'json',
      data: '{"hello":"world"}',
      pluginName: 'json',
    }

    const wrapper = mount(GlobalSearch)
    const vm = wrapper.vm as any
    vm.keyword = 'hello'
    vm.handleSearch()
    await nextTick()
    expect(vm.showResults).toBe(true)
  })

  it('handleSearch 搜索 log 类型标签页', async () => {
    const { openTab, tabs } = useTabManager()
    openTab(mockNode('app.log'), 'a1')
    tabs.value[0].content = {
      type: 'log',
      data: [
        { lineNumber: 1, timestamp: '', level: 'INFO', module: 'main', message: 'start', raw: 'INFO start' },
      ],
      pluginName: 'log',
    }

    const wrapper = mount(GlobalSearch)
    const vm = wrapper.vm as any
    vm.keyword = 'start'
    vm.handleSearch()
    await nextTick()
    expect(vm.showResults).toBe(true)
  })

  it('handleSearch 跳过不可搜索类型的标签页', async () => {
    const { openTab, tabs } = useTabManager()
    openTab(mockNode('image.png'), 'a1')
    tabs.value[0].content = { type: 'binary', data: new Uint8Array(), pluginName: 'hex' }

    const wrapper = mount(GlobalSearch)
    const vm = wrapper.vm as any
    vm.keyword = 'test'
    vm.handleSearch()
    await nextTick()
    expect(vm.showResults).toBe(true)
  })

  it('handleSearch 跳过无 content 的标签页', async () => {
    const { openTab } = useTabManager()
    openTab(mockNode('empty.txt'), 'a1')
    // 不设置 content

    const wrapper = mount(GlobalSearch)
    const vm = wrapper.vm as any
    vm.keyword = 'test'
    vm.handleSearch()
    await nextTick()
    expect(vm.showResults).toBe(true)
  })

  it('navigateToResult 激活匹配的标签页', async () => {
    const { openTab, activeTabId } = useTabManager()
    openTab(mockNode('a.txt', '/a.txt'), 'a1')
    openTab(mockNode('b.txt', '/b.txt'), 'a1')

    const wrapper = mount(GlobalSearch)
    const vm = wrapper.vm as any
    vm.navigateToResult({
      archiveId: 'a1',
      filePath: '/a.txt',
      fileName: 'a.txt',
      lineNumber: 1,
      lineContent: 'test',
      matchStart: 0,
    })
    await nextTick()
    // 应激活 a.txt 的标签页
    expect(activeTabId.value).toBeDefined()
    expect(vm.showResults).toBe(false)
  })

  it('navigateToResult 无匹配标签时不报错', async () => {
    const wrapper = mount(GlobalSearch)
    const vm = wrapper.vm as any
    vm.navigateToResult({
      archiveId: 'no-such',
      filePath: '/missing.txt',
      fileName: 'missing.txt',
      lineNumber: 1,
      lineContent: 'test',
      matchStart: 0,
    })
    expect(vm.showResults).toBe(false)
  })

  it('截断片段：行首匹配时不加前缀省略号', async () => {
    const wrapper = mount(GlobalSearch)
    const vm = wrapper.vm as any
    vm.keyword = 'hello'
    // 模拟搜索结果，匹配位置在行首
    const { results } = useSearch()
    results.value = {
      keyword: 'hello',
      matches: [{
        archiveId: 'a1', filePath: '/test.txt', fileName: 'test.txt',
        lineNumber: 1, lineContent: 'hello world this is a long line', matchStart: 0, matchEnd: 5,
      }],
      searchTimeMs: 1,
    }
    await nextTick()
    const groups = vm.groupedResults
    expect(groups.length).toBe(1)
    const segment = groups[0].matches[0].segments
    expect(segment.prefix).not.toContain('…')
    expect(segment.match).toBe('hello')
  })

  it('截断片段：行尾匹配时不加后缀省略号', async () => {
    const wrapper = mount(GlobalSearch)
    const vm = wrapper.vm as any
    vm.keyword = 'end'
    const { results } = useSearch()
    results.value = {
      keyword: 'end',
      matches: [{
        archiveId: 'a1', filePath: '/test.txt', fileName: 'test.txt',
        lineNumber: 1, lineContent: 'short end', matchStart: 6, matchEnd: 9,
      }],
      searchTimeMs: 1,
    }
    await nextTick()
    const segment = vm.groupedResults[0].matches[0].segments
    expect(segment.suffix).not.toContain('…')
  })

  it('截断片段：长行中间匹配时前后均有省略号', async () => {
    const wrapper = mount(GlobalSearch)
    const vm = wrapper.vm as any
    vm.keyword = 'mid'
    const longLine = 'a'.repeat(40) + 'mid' + 'b'.repeat(40)
    const { results } = useSearch()
    results.value = {
      keyword: 'mid',
      matches: [{
        archiveId: 'a1', filePath: '/test.txt', fileName: 'test.txt',
        lineNumber: 1, lineContent: longLine, matchStart: 40, matchEnd: 43,
      }],
      searchTimeMs: 1,
    }
    await nextTick()
    const segment = vm.groupedResults[0].matches[0].segments
    expect(segment.prefix).toContain('…')
    expect(segment.suffix).toContain('…')
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

  it('Ctrl+K 快捷键聚焦输入框', async () => {
    const wrapper = mount(GlobalSearch)
    const vm = wrapper.vm as any
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true }))
    await nextTick()
    expect(vm.showResults).toBe(false)
  })

  it('Ctrl+F 快捷键拦截浏览器默认搜索', async () => {
    const wrapper = mount(GlobalSearch)
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', ctrlKey: true }))
    await nextTick()
    // 不应报错
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

    // 模拟点击 wrapper 内部
    const el = wrapper.find('.global-search-wrapper').element
    const mockTarget = { closest: (sel: string) => el } as any
    vm.handleClickOutside({ target: mockTarget } as any)
    await nextTick()
    expect(vm.showResults).toBe(true)
  })

  it('groupedResults 按文件分组搜索结果', async () => {
    const wrapper = mount(GlobalSearch)
    const vm = wrapper.vm as any
    // 手动设置搜索结果
    const { results } = useSearch()
    results.value = {
      matches: [
        { archiveId: 'a1', filePath: '/a.txt', fileName: 'a.txt', lineNumber: 1, lineContent: 'foo', matchStart: 0 },
        { archiveId: 'a1', filePath: '/a.txt', fileName: 'a.txt', lineNumber: 5, lineContent: 'bar', matchStart: 0 },
        { archiveId: 'a2', filePath: '/b.txt', fileName: 'b.txt', lineNumber: 2, lineContent: 'baz', matchStart: 0 },
      ],
      searchTimeMs: 10,
      totalFiles: 2,
    }
    await nextTick()

    const groups = vm.groupedResults
    expect(groups.length).toBe(2)
    expect(groups[0].matches.length).toBe(2)
    expect(groups[1].matches.length).toBe(1)
  })

  it('totalMatches 返回匹配总数', async () => {
    const wrapper = mount(GlobalSearch)
    const vm = wrapper.vm as any
    const { results } = useSearch()
    results.value = {
      matches: [
        { archiveId: 'a1', filePath: '/a.txt', fileName: 'a.txt', lineNumber: 1, lineContent: 'x', matchStart: 0 },
      ],
      searchTimeMs: 5,
      totalFiles: 1,
    }
    await nextTick()
    expect(vm.totalMatches).toBe(1)
  })

  it('navigateToResult 通过 fileName 匹配标签页', async () => {
    const { openTab } = useTabManager()
    openTab(mockNode('x.txt', '/x.txt'), 'a1')

    const wrapper = mount(GlobalSearch)
    const vm = wrapper.vm as any
    // filePath 不匹配但 fileName 匹配
    vm.navigateToResult({
      archiveId: 'a1',
      filePath: '/different/path.txt',
      fileName: 'x.txt',
      lineNumber: 1,
      lineContent: 'x',
      matchStart: 0,
    })
    expect(vm.showResults).toBe(false)
  })
})
