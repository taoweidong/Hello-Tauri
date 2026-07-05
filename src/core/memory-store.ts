/** 内存存储上限（默认 256MB），防止大文件场景内存溢出 */
const DEFAULT_MAX_BYTES = 256 * 1024 * 1024

/**
 * 内存字节存储，基于 LRU 策略管理
 * 用于缓存解压后的文件数据，避免重复 IO
 */
export class MemoryStore {
  private store = new Map<string, Uint8Array>()
  /** 当前已用字节数 */
  private totalBytes = 0
  /** 存储上限（字节） */
  private maxBytes: number

  /**
   * @param maxBytes - 存储上限，默认 256MB
   */
  constructor(maxBytes = DEFAULT_MAX_BYTES) {
    this.maxBytes = maxBytes
  }

  /**
   * 写入数据到内存存储
   * @param path - 存储路径键
   * @param data - 要存储的字节数据
   */
  write(path: string, data: Uint8Array): void {
    // 写入前清理旧数据占用
    const old = this.store.get(path)
    if (old) {
      this.totalBytes -= old.byteLength
    }
    // 容量检查：超出上限时拒绝写入并淘汰最早条目
    if (this.totalBytes + data.byteLength > this.maxBytes) {
      this.evict(data.byteLength)
    }
    this.store.set(path, data)
    this.totalBytes += data.byteLength
  }

  /**
   * 读取指定路径的数据
   * @param path - 存储路径键
   * @returns 对应的字节数据，不存在时返回 undefined
   */
  read(path: string): Uint8Array | undefined {
    return this.store.get(path)
  }

  /**
   * 判断指定路径是否存在
   * @param path - 存储路径键
   * @returns 是否存在
   */
  has(path: string): boolean {
    return this.store.has(path)
  }

  /** 清空所有存储数据并重置计数 */
  clear(): void {
    this.store.clear()
    this.totalBytes = 0
  }

  /** 当前存储的条目数量 */
  get size(): number {
    return this.store.size
  }

  /** 当前已用字节数 */
  get usedBytes(): number {
    return this.totalBytes
  }

  /** LRU 淘汰：按插入顺序删除条目，直到有足够空间 */
  private evict(neededBytes: number): void {
    const keys = Array.from(this.store.keys())
    for (const key of keys) {
      if (this.totalBytes + neededBytes <= this.maxBytes) break
      const val = this.store.get(key)!
      this.totalBytes -= val.byteLength
      this.store.delete(key)
    }
  }
}

export const memoryStore = new MemoryStore()
