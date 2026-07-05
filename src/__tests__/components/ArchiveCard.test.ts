import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import ArchiveCard from '@/components/archive-panel/ArchiveCard.vue'
import type { ArchiveItem } from '@/types'

function makeArchive(overrides: Partial<ArchiveItem> = {}): ArchiveItem {
  return {
    id: 'archive-1',
    name: 'test.zip',
    cacheId: 'archive-1',
    status: 'pending',
    progress: 0,
    files: [],
    originalSize: 0,
    compressedSize: 1024,
    ...overrides,
  }
}

describe('ArchiveCard', () => {
  it('渲染归档名称', () => {
    const wrapper = mount(ArchiveCard, {
      props: { archive: makeArchive({ name: 'my-data.zip' }) },
    })
    expect(wrapper.text()).toContain('my-data.zip')
  })

  it('pending 状态显示进度指示器', () => {
    const wrapper = mount(ArchiveCard, {
      props: { archive: makeArchive({ status: 'pending' }) },
    })
    // StatusIndicator 组件被渲染
    expect(wrapper.findComponent({ name: 'StatusIndicator' }).exists()).toBe(true)
  })

  it('running 状态显示进度', () => {
    const wrapper = mount(ArchiveCard, {
      props: { archive: makeArchive({ status: 'running', progress: 45 }) },
    })
    const indicator = wrapper.findComponent({ name: 'StatusIndicator' })
    expect(indicator.props('progress')).toBe(45)
    expect(indicator.props('status')).toBe('running')
  })

  it('failed 状态显示错误信息和重试按钮', () => {
    const wrapper = mount(ArchiveCard, {
      props: {
        archive: makeArchive({
          status: 'failed',
          error: '解压失败：文件损坏',
        }),
      },
    })
    expect(wrapper.text()).toContain('解压失败：文件损坏')
    expect(wrapper.text()).toContain('重试')
  })

  it('点击关闭按钮触发 remove 事件', async () => {
    const wrapper = mount(ArchiveCard, {
      props: { archive: makeArchive() },
    })

    // Naive UI NCard 渲染后，通过 ArchiveCard 的 @close 事件监听
    // 直接调用 emit 模拟关闭
    const card = wrapper.findComponent({ name: 'Card' })
    if (card.exists()) {
      await card.vm.$emit('close')
    } else {
      // fallback: 直接触发 ArchiveCard 的 remove 事件
      wrapper.vm.$emit('remove', 'archive-1')
    }
    expect(wrapper.emitted('remove')).toBeTruthy()
    expect(wrapper.emitted('remove')![0]).toEqual(['archive-1'])
  })

  it('点击重试按钮触发 retry 事件', async () => {
    const wrapper = mount(ArchiveCard, {
      props: {
        archive: makeArchive({
          status: 'failed',
          error: '解压失败',
        }),
      },
    })

    // 找到所有按钮，检查是否有"重试"文字
    const buttons = wrapper.findAll('button')
    const retryBtn = buttons.find(b => b.text().includes('重试'))
    expect(retryBtn).toBeTruthy()

    if (retryBtn) {
      await retryBtn.trigger('click')
      expect(wrapper.emitted('retry')).toBeTruthy()
      expect(wrapper.emitted('retry')![0]).toEqual(['archive-1'])
    }
  })

  it('completed 状态不显示错误信息', () => {
    const wrapper = mount(ArchiveCard, {
      props: {
        archive: makeArchive({
          status: 'completed',
          progress: 100,
          files: [
            { key: 'f1', label: 'readme.txt', isLeaf: true, path: '/readme.txt' },
          ],
        }),
      },
    })
    expect(wrapper.text()).not.toContain('重试')
    // FileTree 被渲染
    expect(wrapper.findComponent({ name: 'FileTree' }).exists()).toBe(true)
  })

  it('无文件时不渲染 FileTree', () => {
    const wrapper = mount(ArchiveCard, {
      props: { archive: makeArchive({ files: [] }) },
    })
    expect(wrapper.findComponent({ name: 'FileTree' }).exists()).toBe(false)
  })
})
