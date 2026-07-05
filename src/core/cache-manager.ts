/**
 * LRU 缓存管理器
 * 负责缓存归档的写入、恢复、按需读取与 LRU 淘汰
 * 通过 ICacheStorage 接口屏蔽平台差异
 */
import type { ICacheStorage, CacheMeta } from './cache-storage'
import type { ArchiveItem } from '@/types'

export interface CacheManagerOptions {
  /** 最大缓存归档数量，超出后 LRU 淘汰，默认 20 */
  maxItems?: number
}

export class CacheManager {
  private storage: ICacheStorage
  private maxItems: number
  /** 内存中缓存所有 id 对应的 lastAccessed，用于快速 LRU 计算 */
  private accessMap = new Map<string, number>()

  constructor(storage: ICacheStorage, options?: CacheManagerOptions) {
    this.storage = storage
    this.maxItems = options?.maxItems ?? 20
  }

  /** 初始化存储后端并执行 LRU 淘汰 */
  async init(): Promise<void> {
    await this.storage.init()
    await this.evict()
  }

  /**
   * 将归档文件及其元数据写入缓存
   * @param archive 归档项
   * @param file 原始 File 对象（当次会话中可用）
   */
  async cacheArchive(archive: ArchiveItem, file?: File): Promise<void> {
    const now = Date.now()
    // 捕获当前状态快照用于元数据保存
    const meta: CacheMeta = {
      id: archive.id,
      name: archive.name,
      size: file?.size ?? archive.compressedSize,
      lastModified: file?.lastModified ?? 0,
      status: archive.status,
      files: archive.files,
      originalSize: archive.originalSize,
      compressedSize: archive.compressedSize,
      startTime: archive.startTime,
      endTime: archive.endTime,
      error: archive.error,
      lastAccessed: now,
    }

    // 先保存元数据（必须 await，防止后续 updateMeta 的 status 更新被此处的旧状态覆盖）
    await this.storage.saveMeta(archive.id, meta)
    this.accessMap.set(archive.id, now)

    // 二进制数据异步保存（不阻塞调用方，不影响元数据状态）
    if (file) {
      const data = new Uint8Array(await file.arrayBuffer())
      await this.storage.saveFileData(archive.id, data)
    }
  }

  /**
   * 更新缓存中的元数据（解压完成后更新文件树等）
   */
  async updateMeta(archive: ArchiveItem): Promise<void> {
    const existing = await this.storage.loadMeta(archive.id)
    if (!existing) return

    const updated: CacheMeta = {
      ...existing,
      status: archive.status,
      files: archive.files,
      originalSize: archive.originalSize,
      compressedSize: archive.compressedSize,
      startTime: archive.startTime,
      endTime: archive.endTime,
      error: archive.error,
    }
    await this.storage.saveMeta(archive.id, updated)
  }

  /**
   * 按需读取归档的二进制文件数据
   * 读取后自动更新 lastAccessed（LRU touch）
   */
  async getFileData(id: string): Promise<Uint8Array | null> {
    const data = await this.storage.loadFileData(id)
    if (data) {
      await this.touch(id)
    }
    return data
  }

  /**
   * 启动时恢复所有归档的元数据列表
   * 不包含二进制数据，仅返回 CacheMeta 数组
   * 结果已按 lastAccessed 升序排列（loadAllMeta 保证）
   */
  async restoreAll(): Promise<CacheMeta[]> {
    const allMeta = await this.storage.loadAllMeta()
    // 重建内存 accessMap
    this.accessMap.clear()
    for (const meta of allMeta) {
      this.accessMap.set(meta.id, meta.lastAccessed)
    }
    return allMeta
  }

  /** 删除归档缓存（元数据 + 二进制数据） */
  async remove(id: string): Promise<void> {
    await Promise.all([
      this.storage.deleteMeta(id),
      this.storage.deleteFileData(id),
    ])
    this.accessMap.delete(id)
  }

  /** 更新缓存项的 lastAccessed 时间戳 */
  async touch(id: string): Promise<void> {
    const now = Date.now()
    this.accessMap.set(id, now)
    const meta = await this.storage.loadMeta(id)
    if (meta) {
      meta.lastAccessed = now
      await this.storage.saveMeta(id, meta)
    }
  }

  /** LRU 淘汰：若缓存数量超过 maxItems，删除最久未访问的缓存 */
  private async evict(): Promise<void> {
    const allMeta = await this.storage.loadAllMeta()
    // loadAllMeta 已按 lastAccessed 升序排列（最旧在前）
    if (allMeta.length <= this.maxItems) return

    const toRemove = allMeta.slice(0, allMeta.length - this.maxItems)
    for (const meta of toRemove) {
      await this.remove(meta.id)
    }
  }
}
