/** 内存存储上限（默认 256MB），防止大文件场景内存溢出 */
const DEFAULT_MAX_BYTES = 256 * 1024 * 1024

export class MemoryStore {
  private store = new Map<string, Uint8Array>()
  private totalBytes = 0
  private maxBytes: number

  constructor(maxBytes = DEFAULT_MAX_BYTES) {
    this.maxBytes = maxBytes
  }

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

  read(path: string): Uint8Array | undefined {
    return this.store.get(path)
  }

  has(path: string): boolean {
    return this.store.has(path)
  }

  clear(): void {
    this.store.clear()
    this.totalBytes = 0
  }

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
