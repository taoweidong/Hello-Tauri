/**
 * IndexedDB 缓存存储实现（Web 端）
 * 数据库：hello-tauri-cache
 * ObjectStore：meta（元数据）、filedata（二进制）
 */
import type { ICacheStorage, CacheMeta } from './cache-storage'

const DB_NAME = 'hello-tauri-cache'
const DB_VERSION = 1
const META_STORE = 'meta'
const DATA_STORE = 'filedata'

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

export class IdbCacheStorage implements ICacheStorage {
  private db: IDBDatabase | null = null

  async init(): Promise<void> {
    this.db = await openDB()
  }

  private getDB(): IDBDatabase {
    if (!this.db) throw new Error('IdbCacheStorage 未初始化，请先调用 init()')
    return this.db
  }

  async saveMeta(id: string, meta: CacheMeta): Promise<void> {
    const db = this.getDB()
    const tx = db.transaction(META_STORE, 'readwrite')
    const store = tx.objectStore(META_STORE)
    await idbRequest(store.put(meta))
  }

  async loadMeta(id: string): Promise<CacheMeta | null> {
    const db = this.getDB()
    const tx = db.transaction(META_STORE, 'readonly')
    const store = tx.objectStore(META_STORE)
    const result = await idbRequest(store.get(id))
    return result ?? null
  }

  async loadAllMeta(): Promise<CacheMeta[]> {
    const db = this.getDB()
    const tx = db.transaction(META_STORE, 'readonly')
    const store = tx.objectStore(META_STORE)
    const all: CacheMeta[] = await idbRequest(store.getAll())
    // 按 lastAccessed 升序排列（最旧在前，便于 LRU 淘汰）
    return all.sort((a, b) => a.lastAccessed - b.lastAccessed)
  }

  async deleteMeta(id: string): Promise<void> {
    const db = this.getDB()
    const tx = db.transaction(META_STORE, 'readwrite')
    const store = tx.objectStore(META_STORE)
    await idbRequest(store.delete(id))
  }

  async saveFileData(id: string, data: Uint8Array): Promise<void> {
    const db = this.getDB()
    const tx = db.transaction(DATA_STORE, 'readwrite')
    const store = tx.objectStore(DATA_STORE)
    await idbRequest(store.put(data, id))
  }

  async loadFileData(id: string): Promise<Uint8Array | null> {
    const db = this.getDB()
    const tx = db.transaction(DATA_STORE, 'readonly')
    const store = tx.objectStore(DATA_STORE)
    const result = await idbRequest(store.get(id))
    return result ?? null
  }

  async deleteFileData(id: string): Promise<void> {
    const db = this.getDB()
    const tx = db.transaction(DATA_STORE, 'readwrite')
    const store = tx.objectStore(DATA_STORE)
    await idbRequest(store.delete(id))
  }

  async listIds(): Promise<string[]> {
    const db = this.getDB()
    const tx = db.transaction(META_STORE, 'readonly')
    const store = tx.objectStore(META_STORE)
    const keys = await idbRequest(store.getAllKeys())
    return keys.map(k => String(k))
  }
}
