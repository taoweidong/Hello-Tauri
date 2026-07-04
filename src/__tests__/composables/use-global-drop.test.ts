import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// 用 vi.fn() 包装以便 mock 可追踪
const mockAddFiles = vi.fn()
const mockWarning = vi.fn()
const mockError = vi.fn()
const mockValidate = vi.fn().mockResolvedValue({ ok: true })

vi.mock('@/composables/use-archives', () => ({
  useArchiveManager: vi.fn(() => ({
    addFiles: mockAddFiles,
  })),
}))

vi.mock('naive-ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('naive-ui')>()
  return {
    ...actual,
    useMessage: vi.fn(() => ({
      warning: mockWarning,
      error: mockError,
    })),
  }
})

vi.mock('@/core/file-validator', () => ({
  getFileValidator: vi.fn(() => ({
    validate: mockValidate,
  })),
}))

import { useGlobalDrop } from '@/composables/use-global-drop'

describe('useGlobalDrop', () => {
  let composable: ReturnType<typeof useGlobalDrop>
  let el: HTMLDivElement

  beforeEach(() => {
    mockAddFiles.mockClear()
    mockWarning.mockClear()
    mockError.mockClear()
    mockValidate.mockClear().mockResolvedValue({ ok: true })
    composable = useGlobalDrop()
    el = document.createElement('div')
    document.body.appendChild(el)
    composable.setup(el)
  })

  afterEach(() => {
    composable.cleanup()
    document.body.removeChild(el)
  })

  it('初始状态 isDragging 为 false', () => {
    expect(composable.isDragging.value).toBe(false)
  })

  it('dragenter 后 isDragging 变为 true', () => {
    const dt = new DataTransfer()
    dt.items.add(new File(['test'], 'test.zip', { type: 'application/zip' }))
    el.dispatchEvent(new DragEvent('dragenter', { dataTransfer: dt, bubbles: true }))
    expect(composable.isDragging.value).toBe(true)
  })

  it('dragenter 后 dragleave 恢复 false', () => {
    const dt = new DataTransfer()
    dt.items.add(new File(['test'], 'test.zip', { type: 'application/zip' }))
    el.dispatchEvent(new DragEvent('dragenter', { dataTransfer: dt, bubbles: true }))
    expect(composable.isDragging.value).toBe(true)
    el.dispatchEvent(new DragEvent('dragleave', { dataTransfer: dt, bubbles: true }))
    expect(composable.isDragging.value).toBe(false)
  })

  it('drop 压缩包文件后调用 addFiles', async () => {
    const dt = new DataTransfer()
    dt.items.add(new File(['data'], 'archive.zip', { type: 'application/zip' }))
    const dropEvent = new DragEvent('drop', { dataTransfer: dt, bubbles: true })
    el.dispatchEvent(dropEvent)

    // onDrop 是异步的，等待验证完成
    await vi.waitFor(() => {
      expect(mockAddFiles).toHaveBeenCalledTimes(1)
      expect(mockAddFiles).toHaveBeenCalledWith(
        expect.arrayContaining([expect.objectContaining({ name: 'archive.zip' })])
      )
    })
  })

  it('drop 验证失败的文件不调用 addFiles，且提示 error', async () => {
    mockValidate.mockResolvedValueOnce({ ok: false, message: '压缩包中缺少必要文件：VERSION.txt' })
    const dt = new DataTransfer()
    dt.items.add(new File(['data'], 'bad.zip', { type: 'application/zip' }))
    const dropEvent = new DragEvent('drop', { dataTransfer: dt, bubbles: true })
    el.dispatchEvent(dropEvent)

    await vi.waitFor(() => {
      expect(mockAddFiles).not.toHaveBeenCalled()
      expect(mockError).toHaveBeenCalledWith('bad.zip：压缩包中缺少必要文件：VERSION.txt')
    })
  })

  it('drop 非压缩包文件不调用 addFiles，且提示 warning', async () => {
    const dt = new DataTransfer()
    dt.items.add(new File(['data'], 'readme.txt', { type: 'text/plain' }))
    const dropEvent = new DragEvent('drop', { dataTransfer: dt, bubbles: true })
    el.dispatchEvent(dropEvent)

    expect(mockAddFiles).not.toHaveBeenCalled()
    expect(mockWarning).toHaveBeenCalledWith('仅支持压缩包文件')
  })

  it('cleanup 后事件不再触发', () => {
    composable.cleanup()
    const dt = new DataTransfer()
    dt.items.add(new File(['test'], 'test.zip', { type: 'application/zip' }))
    el.dispatchEvent(new DragEvent('dragenter', { dataTransfer: dt, bubbles: true }))
    expect(composable.isDragging.value).toBe(false)
  })

  it('drop 空文件列表时不调用任何方法', async () => {
    const dt = new DataTransfer()
    // 不添加任何文件
    const dropEvent = new DragEvent('drop', { dataTransfer: dt, bubbles: true })
    el.dispatchEvent(dropEvent)
    expect(mockAddFiles).not.toHaveBeenCalled()
    expect(mockWarning).not.toHaveBeenCalled()
    expect(mockError).not.toHaveBeenCalled()
  })

  it('drop 混合文件时忽略非压缩包，并提示警告', async () => {
    const dt = new DataTransfer()
    dt.items.add(new File(['data'], 'archive.zip', { type: 'application/zip' }))
    dt.items.add(new File(['data'], 'readme.txt', { type: 'text/plain' }))
    const dropEvent = new DragEvent('drop', { dataTransfer: dt, bubbles: true })
    el.dispatchEvent(dropEvent)

    await vi.waitFor(() => {
      expect(mockWarning).toHaveBeenCalledWith('已忽略 1 个非压缩包文件')
      expect(mockAddFiles).toHaveBeenCalledWith(
        expect.arrayContaining([expect.objectContaining({ name: 'archive.zip' })])
      )
    })
  })

  it('dragenter 嵌套子元素时 isDragging 保持 true', () => {
    const dt = new DataTransfer()
    dt.items.add(new File(['test'], 'test.zip', { type: 'application/zip' }))
    // 模拟进入父元素
    el.dispatchEvent(new DragEvent('dragenter', { dataTransfer: dt, bubbles: true }))
    // 模拟进入子元素（counter 增加）
    el.dispatchEvent(new DragEvent('dragenter', { dataTransfer: dt, bubbles: true }))
    expect(composable.isDragging.value).toBe(true)
    // 离开一次（counter 减 1，但不为 0）
    el.dispatchEvent(new DragEvent('dragleave', { dataTransfer: dt, bubbles: true }))
    expect(composable.isDragging.value).toBe(true)
    // 再离开一次（counter 为 0）
    el.dispatchEvent(new DragEvent('dragleave', { dataTransfer: dt, bubbles: true }))
    expect(composable.isDragging.value).toBe(false)
  })

  it('drop 后 isDragging 重置为 false', async () => {
    const dt = new DataTransfer()
    dt.items.add(new File(['data'], 'archive.zip', { type: 'application/zip' }))
    el.dispatchEvent(new DragEvent('dragenter', { dataTransfer: dt, bubbles: true }))
    expect(composable.isDragging.value).toBe(true)
    const dropEvent = new DragEvent('drop', { dataTransfer: dt, bubbles: true })
    el.dispatchEvent(dropEvent)
    expect(composable.isDragging.value).toBe(false)
  })

  it('cleanup 未 setup 时不报错', () => {
    const fresh = useGlobalDrop()
    expect(() => fresh.cleanup()).not.toThrow()
  })
})
