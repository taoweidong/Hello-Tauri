// 测试环境缓存模块 mock：使用内存存储替代 IndexedDB/文件系统
import { vi } from 'vitest'
import { MemoryCacheStorage } from './memory-cache-storage'
import { CacheManager } from '@/core/cache-manager'

let testCacheManager: CacheManager | null = null
const testStorage = new MemoryCacheStorage()

vi.mock('@/composables/use-cache', () => ({
  useCacheManager: () => {
    if (!testCacheManager) {
      testCacheManager = new CacheManager(testStorage)
    }
    return testCacheManager
  },
  initCache: async () => {
    if (!testCacheManager) {
      testCacheManager = new CacheManager(testStorage)
      await testCacheManager.init()
    }
    return testCacheManager
  },
  resetCache: () => {
    testCacheManager = null
    testStorage.clear()
  },
}))

// jsdom 不支持 DataTransfer / DragEvent，需要 polyfill

class DataTransferItemPolyfill {
  kind: string
  type: string
  #data: string | File

  constructor(kind: string, type: string, data: string | File) {
    this.kind = kind
    this.type = type
    this.#data = data
  }

  getAsFile(): File | null {
    return this.kind === 'file' && this.#data instanceof File ? this.#data : null
  }

  getAsString(callback: (data: string) => void): void {
    if (this.kind === 'string' && typeof this.#data === 'string') {
      callback(this.#data)
    }
  }
}

class DataTransferItemListPolyfill {
  #items: DataTransferItemPolyfill[] = []

  get length(): number {
    return this.#items.length
  }

  add(data: string | File, type?: string): DataTransferItemPolyfill | null {
    if (data instanceof File) {
      const item = new DataTransferItemPolyfill('file', data.type || '', data)
      this.#items.push(item)
      return item
    } else if (typeof data === 'string' && type) {
      const item = new DataTransferItemPolyfill('string', type, data)
      this.#items.push(item)
      return item
    }
    return null
  }

  remove(index: number): void {
    this.#items.splice(index, 1)
  }

  clear(): void {
    this.#items = []
  }

  [Symbol.iterator](): IterableIterator<DataTransferItemPolyfill> {
    return this.#items[Symbol.iterator]()
  }
}

class DataTransferPolyfill {
  items = new DataTransferItemListPolyfill()
  dropEffect: 'none' | 'copy' | 'link' | 'move' = 'none'
  effectAllowed: string = 'uninitialized'

  get files(): FileList {
    const files: File[] = []
    for (const item of this.items) {
      const file = item.getAsFile()
      if (file) files.push(file)
    }
    return files as unknown as FileList
  }

  get types(): string[] {
    const result: string[] = []
    if (this.files.length > 0) result.push('Files')
    for (const item of this.items) {
      if (item.kind === 'string') result.push(item.type)
    }
    return result
  }

  setData(format: string, data: string): void {
    this.items.add(data, format)
  }

  getData(format: string): string {
    for (const item of this.items) {
      if (item.type === format) {
        let result = ''
        item.getAsString((s) => { result = s })
        return result
      }
    }
    return ''
  }

  clearData(_format?: string): void {
    // simplified
  }

  setDragImage(_image: Element, _x: number, _y: number): void {
    // no-op in test
  }
}

if (typeof globalThis.DataTransfer === 'undefined') {
  // @ts-expect-error polyfill for jsdom
  globalThis.DataTransfer = DataTransferPolyfill
}

if (typeof globalThis.FileList === 'undefined') {
  // @ts-expect-error polyfill for jsdom
  globalThis.FileList = class FileList {}
}

if (typeof globalThis.DragEvent === 'undefined') {
  class DragEventPolyfill extends Event {
    dataTransfer: DataTransfer | null
    relatedTarget: Element | null
    constructor(type: string, init?: DragEventInit) {
      super(type, { bubbles: init?.bubbles ?? false, cancelable: init?.cancelable ?? false })
      this.dataTransfer = (init as any)?.dataTransfer ?? null
      this.relatedTarget = (init as any)?.relatedTarget ?? null
    }
  }
  // @ts-expect-error polyfill for jsdom
  globalThis.DragEvent = DragEventPolyfill
}
