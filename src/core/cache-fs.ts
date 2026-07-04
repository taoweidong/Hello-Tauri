/**
 * 文件系统缓存存储实现（Tauri 端）
 * 缓存目录结构：
 *   {app_data_dir}/.cache/meta/{id}.json  — 元数据
 *   {app_data_dir}/.cache/data/{id}.bin   — 二进制文件数据
 */
import type { ICacheStorage, CacheMeta } from './cache-storage'

let invoke: (cmd: string, args?: Record<string, unknown>) => Promise<any>

async function getInvoke() {
  if (!invoke) {
    const tauri = await import('@tauri-apps/api/core')
    invoke = tauri.invoke
  }
  return invoke
}

/** 拼接路径片段（兼容 Windows 和 POSIX） */
function joinPath(...segments: string[]): string {
  return segments.join('/').replace(/\/+/g, '/')
}

export class FsCacheStorage implements ICacheStorage {
  private cacheDir = ''

  async init(): Promise<void> {
    const fn = await getInvoke()
    const appDataDir: string = await fn('get_app_data_dir')
    this.cacheDir = joinPath(appDataDir, '.cache')
    // 确保 meta 和 data 子目录存在
    await fn('ensure_dir', { path: joinPath(this.cacheDir, 'meta') })
    await fn('ensure_dir', { path: joinPath(this.cacheDir, 'data') })
  }

  private metaPath(id: string): string {
    return joinPath(this.cacheDir, 'meta', `${id}.json`)
  }

  private dataPath(id: string): string {
    return joinPath(this.cacheDir, 'data', `${id}.bin`)
  }

  async saveMeta(_id: string, meta: CacheMeta): Promise<void> {
    const fn = await getInvoke()
    const json = JSON.stringify(meta)
    const encoded = new TextEncoder().encode(json)
    await fn('write_file', { path: this.metaPath(meta.id), data: Array.from(encoded) })
  }

  async loadMeta(id: string): Promise<CacheMeta | null> {
    const fn = await getInvoke()
    const path = this.metaPath(id)
    const exists: boolean = await fn('file_exists', { path })
    if (!exists) return null
    try {
      const bytes: number[] = await fn('read_file', { path })
      const json = new TextDecoder().decode(new Uint8Array(bytes))
      return JSON.parse(json) as CacheMeta
    } catch {
      return null
    }
  }

  async loadAllMeta(): Promise<CacheMeta[]> {
    const fn = await getInvoke()
    const metaDir = joinPath(this.cacheDir, 'meta')
    let entries: Array<{ name: string; isDirectory: boolean }>
    try {
      entries = await fn('list_files', { dir: metaDir })
    } catch {
      return []
    }
    const metaList: CacheMeta[] = []
    for (const entry of entries) {
      if (entry.isDirectory || !entry.name.endsWith('.json')) continue
      const id = entry.name.replace(/\.json$/, '')
      const meta = await this.loadMeta(id)
      if (meta) metaList.push(meta)
    }
    // 按 lastAccessed 升序排列（最旧在前，便于 LRU 淘汰）
    return metaList.sort((a, b) => a.lastAccessed - b.lastAccessed)
  }

  async deleteMeta(id: string): Promise<void> {
    const fn = await getInvoke()
    const path = this.metaPath(id)
    try {
      await fn('delete_file', { path })
    } catch {
      // 文件不存在时忽略
    }
  }

  async saveFileData(id: string, data: Uint8Array): Promise<void> {
    const fn = await getInvoke()
    await fn('write_file', { path: this.dataPath(id), data: Array.from(data) })
  }

  async loadFileData(id: string): Promise<Uint8Array | null> {
    const fn = await getInvoke()
    const path = this.dataPath(id)
    const exists: boolean = await fn('file_exists', { path })
    if (!exists) return null
    try {
      const bytes: number[] = await fn('read_file', { path })
      return new Uint8Array(bytes)
    } catch {
      return null
    }
  }

  async deleteFileData(id: string): Promise<void> {
    const fn = await getInvoke()
    const path = this.dataPath(id)
    try {
      await fn('delete_file', { path })
    } catch {
      // 文件不存在时忽略
    }
  }

  async listIds(): Promise<string[]> {
    const fn = await getInvoke()
    const metaDir = joinPath(this.cacheDir, 'meta')
    try {
      const entries: Array<{ name: string; isDirectory: boolean }> =
        await fn('list_files', { dir: metaDir })
      return entries
        .filter(e => !e.isDirectory && e.name.endsWith('.json'))
        .map(e => e.name.replace(/\.json$/, ''))
    } catch {
      return []
    }
  }
}
