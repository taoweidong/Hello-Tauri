/**
 * 内存版缓存存储实现（仅用于测试环境）
 * 不依赖 IndexedDB 或文件系统，数据保存在 Map 中
 */
import type { ICacheStorage, CacheMeta } from '@/core/cache-storage'

export class MemoryCacheStorage implements ICacheStorage {
  private metaMap = new Map<string, CacheMeta>()
  private dataMap = new Map<string, Uint8Array>()

  async init(): Promise<void> {
    // 内存存储无需初始化
  }

  async saveMeta(id: string, meta: CacheMeta): Promise<void> {
    this.metaMap.set(id, { ...meta })
  }

  async loadMeta(id: string): Promise<CacheMeta | null> {
    const meta = this.metaMap.get(id)
    return meta ? { ...meta } : null
  }

  async loadAllMeta(): Promise<CacheMeta[]> {
    const all = Array.from(this.metaMap.values())
    return all.sort((a, b) => a.lastAccessed - b.lastAccessed)
  }

  async deleteMeta(id: string): Promise<void> {
    this.metaMap.delete(id)
  }

  async saveFileData(id: string, data: Uint8Array): Promise<void> {
    this.dataMap.set(id, new Uint8Array(data))
  }

  async loadFileData(id: string): Promise<Uint8Array | null> {
    const data = this.dataMap.get(id)
    return data ? new Uint8Array(data) : null
  }

  async deleteFileData(id: string): Promise<void> {
    this.dataMap.delete(id)
  }

  async listIds(): Promise<string[]> {
    return Array.from(this.metaMap.keys())
  }

  /** 清空所有数据（测试隔离用） */
  clear(): void {
    this.metaMap.clear()
    this.dataMap.clear()
  }
}
