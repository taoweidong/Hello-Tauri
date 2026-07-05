import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import { NMessageProvider } from 'naive-ui'
import UploadZone from '@/components/archive-panel/UploadZone.vue'
import { useArchiveManager } from '@/composables/use-archives'

// 包装 UploadZone 在 NMessageProvider 中以支持 useMessage()
function mountUploadZone() {
  return mount(NMessageProvider, {
    slots: { default: UploadZone },
  })
}

describe('UploadZone', () => {
  beforeEach(() => {
    const { reset } = useArchiveManager()
    reset()
  })

  it('渲染上传提示文字', () => {
    const wrapper = mountUploadZone()
    expect(wrapper.text()).toContain('拖拽压缩包到此处，或点击上传')
  })

  it('包含隐藏的文件输入元素', () => {
    const wrapper = mountUploadZone()
    const input = wrapper.find('input[type="file"]')
    expect(input.exists()).toBe(true)
    expect(input.attributes('multiple')).toBeDefined()
    expect(input.attributes('accept')).toContain('.zip')
    expect(input.attributes('accept')).toContain('.gz')
  })

  it('点击上传区域触发文件选择', async () => {
    const wrapper = mountUploadZone()
    const input = wrapper.find('input[type="file"]')
    const clickSpy = vi.spyOn(input.element as HTMLInputElement, 'click')

    // 找到可点击的上传区域（第一个 .cursor-pointer）
    const dropZone = wrapper.find('.cursor-pointer')
    await dropZone.trigger('click')
    expect(clickSpy).toHaveBeenCalled()
  })

  it('拖入文件时显示激活样式', async () => {
    const wrapper = mountUploadZone()

    // 初始状态无激活样式
    expect(wrapper.find('.\\!border-primary').exists()).toBe(false)

    // 模拟 dragenter
    const dropZone = wrapper.find('.cursor-pointer')
    await dropZone.trigger('dragenter', {
      dataTransfer: new DataTransfer(),
    })

    // 应该有激活样式
    const activeEl = wrapper.find('.\\!border-primary')
    expect(activeEl.exists()).toBe(true)
  })

  it('dragleave 后取消激活样式', async () => {
    const wrapper = mountUploadZone()
    const dropZone = wrapper.find('.cursor-pointer')

    // 拖入
    await dropZone.trigger('dragenter', {
      dataTransfer: new DataTransfer(),
    })
    expect(wrapper.find('.\\!border-primary').exists()).toBe(true)

    // 拖出
    await dropZone.trigger('dragleave')
    await nextTick()

    // 激活样式应消失
    expect(wrapper.find('.\\!border-primary').exists()).toBe(false)
  })

  it('拖入非压缩包文件时保持提示不变', async () => {
    const wrapper = mountUploadZone()
    const dropZone = wrapper.find('.cursor-pointer')

    // 创建一个 txt 文件
    const file = new File(['hello'], 'test.txt', { type: 'text/plain' })
    const dt = new DataTransfer()
    dt.items.add(file)

    await dropZone.trigger('drop', { dataTransfer: dt })

    // 上传区域文字不变（因为非压缩包被过滤）
    expect(wrapper.text()).toContain('拖拽压缩包到此处，或点击上传')
  })
})
