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
   * @returns 是否写入成功（淘汰后仍不足空间时拒绝写入）
   */
  write(path: string, data: Uint8Array): boolean {
    // 写入前清理旧数据占用
    const old = this.store.get(path)
    if (old) {
      this.totalBytes -= old.byteLength
      this.store.delete(path)
    }
    // 容量检查：超出上限时淘汰旧条目
    if (this.totalBytes + data.byteLength > this.maxBytes) {
      this.evict(data.byteLength)
    }
    // 淘汰后仍不足空间，拒绝写入
    if (this.totalBytes + data.byteLength > this.maxBytes) {
      return false
    }
    this.store.set(path, data)
    this.totalBytes += data.byteLength
    return true
  }

  /**
   * 读取指定路径的数据
   * 读取时更新访问顺序（delete + set），实现真正的 LRU
   * @param path - 存储路径键
   * @returns 对应的字节数据，不存在时返回 undefined
   */
  read(path: string): Uint8Array | undefined {
    const data = this.store.get(path)
    if (data !== undefined) {
      // 更新访问顺序：删除后重新插入，使 Map 迭代顺序将该项置后
      this.store.delete(path)
      this.store.set(path, data)
    }
    return data
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

/** 全局内存存储单例，应用范围内共享的解压文件数据缓存 */
export const memoryStore = new MemoryStore()
