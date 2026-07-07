/**
 * IndexedDB 缓存存储实现（Web 端）
 * ObjectStore：meta（元数据）、filedata（二进制）
 */
import type { ICacheStorage, CacheMeta } from './cache-storage'
import { DB_NAME } from '@/config'
/** IndexedDB 数据库版本号 */
const DB_VERSION = 1
/** 元数据 ObjectStore 名称 */
const META_STORE = 'meta'
/** 二进制数据 ObjectStore 名称 */
const DATA_STORE = 'filedata'

/** 打开 IndexedDB 数据库，自动创建所需的 ObjectStore */
function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(META_STORE)) {
        db.createObjectStore(META_STORE, { keyPath: 'id' })
      }
      if (!db.objectStoreNames.contains(DATA_STORE)) {
        db.createObjectStore(DATA_STORE)
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

/** 执行单个 IDB 事务请求并返回结果 */
function idbRequest<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

/** IndexedDB 缓存存储实现（Web 端） */
export class IdbCacheStorage implements ICacheStorage {
  /** 数据库连接实例 */
  private db: IDBDatabase | null = null

  /**
   * 初始化数据库连接
   * @returns 数据库连接建立后 resolve
   */
  async init(): Promise<void> {
    this.db = await openDB()
  }

  /** 获取数据库实例，未初始化时抛出异常 */
  private getDB(): IDBDatabase {
    if (!this.db) throw new Error('IdbCacheStorage 未初始化，请先调用 init()')
    return this.db
  }

  /**
   * 保存归档元数据
   * @param id - 归档 id
   * @param meta - 缓存元数据
   */
  async saveMeta(id: string, meta: CacheMeta): Promise<void> {
    const db = this.getDB()
    const tx = db.transaction(META_STORE, 'readwrite')
    const store = tx.objectStore(META_STORE)
    await idbRequest(store.put(meta))
  }

  /**
   * 读取单个归档元数据
   * @param id - 归档 id
   * @returns 缓存元数据，不存在时返回 null
   */
  async loadMeta(id: string): Promise<CacheMeta | null> {
    const db = this.getDB()
    const tx = db.transaction(META_STORE, 'readonly')
    const store = tx.objectStore(META_STORE)
    const result = await idbRequest(store.get(id))
    return result ?? null
  }

  /**
   * 读取所有归档元数据，按 lastAccessed 升序排列
   * @returns 元数据数组
   */
  async loadAllMeta(): Promise<CacheMeta[]> {
    const db = this.getDB()
    const tx = db.transaction(META_STORE, 'readonly')
    const store = tx.objectStore(META_STORE)
    const all: CacheMeta[] = await idbRequest(store.getAll())
    // 按 lastAccessed 升序排列（最旧在前，便于 LRU 淘汰）
    return all.sort((a, b) => a.lastAccessed - b.lastAccessed)
  }

  /**
   * 删除归档元数据
   * @param id - 归档 id
   */
  async deleteMeta(id: string): Promise<void> {
    const db = this.getDB()
    const tx = db.transaction(META_STORE, 'readwrite')
    const store = tx.objectStore(META_STORE)
    await idbRequest(store.delete(id))
  }

  /**
   * 保存归档二进制数据
   * @param id - 归档 id
   * @param data - 字节数组
   */
  async saveFileData(id: string, data: Uint8Array): Promise<void> {
    const db = this.getDB()
    const tx = db.transaction(DATA_STORE, 'readwrite')
    const store = tx.objectStore(DATA_STORE)
    await idbRequest(store.put(data, id))
  }

  /**
   * 读取归档二进制数据
   * @param id - 归档 id
   * @returns 字节数组，不存在时返回 null
   */
  async loadFileData(id: string): Promise<Uint8Array | null> {
    const db = this.getDB()
    const tx = db.transaction(DATA_STORE, 'readonly')
    const store = tx.objectStore(DATA_STORE)
    const result = await idbRequest(store.get(id))
    return result ?? null
  }

  /**
   * 删除归档二进制数据
   * @param id - 归档 id
   */
  async deleteFileData(id: string): Promise<void> {
    const db = this.getDB()
    const tx = db.transaction(DATA_STORE, 'readwrite')
    const store = tx.objectStore(DATA_STORE)
    await idbRequest(store.delete(id))
  }

  /**
   * 列出所有已缓存的归档 id
   * @returns 归档 id 字符串数组
   */
  async listIds(): Promise<string[]> {
    const db = this.getDB()
    const tx = db.transaction(META_STORE, 'readonly')
    const store = tx.objectStore(META_STORE)
    const keys = await idbRequest(store.getAllKeys())
    return keys.map(k => String(k))
  }
}
