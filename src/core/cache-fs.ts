/** 文件系统缓存存储实现（Tauri 端）
 * 缓存目录结构：
 *   {app_data_dir}/.cache/meta/{id}.json  — 元数据
 *   {app_data_dir}/.cache/data/{id}.bin   — 二进制文件数据
 */
import type { ICacheStorage, CacheMeta } from './cache-storage'

/** 懒加载 Tauri invoke 函数 */
let invoke: (cmd: string, args?: Record<string, unknown>) => Promise<any>

/** 获取 Tauri invoke 函数单例 */
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

/** 文件系统缓存存储实现（Tauri 端） */
export class FsCacheStorage implements ICacheStorage {
  /** 缓存根目录路径 */
  private cacheDir = ''

  /**
   * 初始化缓存目录（创建 meta/data 子目录）
   * @returns 初始化完成后 resolve
   */
  async init(): Promise<void> {
    const fn = await getInvoke()
    const appDataDir: string = await fn('get_app_data_dir')
    this.cacheDir = joinPath(appDataDir, '.cache')
    // 确保 meta 和 data 子目录存在
    await fn('ensure_dir', { path: joinPath(this.cacheDir, 'meta') })
    await fn('ensure_dir', { path: joinPath(this.cacheDir, 'data') })
  }

  /** 获取元数据文件路径 */
  private metaPath(id: string): string {
    return joinPath(this.cacheDir, 'meta', `${id}.json`)
  }

  /** 获取二进制数据文件路径 */
  private dataPath(id: string): string {
    return joinPath(this.cacheDir, 'data', `${id}.bin`)
  }

  /**
   * 读取文件原始字节（存在检查 + 错误处理）
   * @returns 字节数组，文件不存在或读取出错时返回 null
   */
  private async readRawBytes(path: string): Promise<number[] | null> {
    const fn = await getInvoke()
    const exists: boolean = await fn('file_exists', { path })
    if (!exists) return null
    try {
      return await fn('read_file', { path })
    } catch (e) {
      console.warn(`[CacheFS] 读取文件失败: ${path}`, e)
      return null
    }
  }

  /**
   * 保存归档元数据为 JSON 文件
   * @param _id - 归档 id（当前未使用，由 meta.id 决定路径）
   * @param meta - 缓存元数据
   */
  async saveMeta(_id: string, meta: CacheMeta): Promise<void> {
    const fn = await getInvoke()
    const json = JSON.stringify(meta)
    const encoded = new TextEncoder().encode(json)
    await fn('write_file', { path: this.metaPath(meta.id), data: Array.from(encoded) })
  }

  /**
   * 读取单个归档元数据
   * @param id - 归档 id
   * @returns 缓存元数据，不存在或解析失败时返回 null
   */
  async loadMeta(id: string): Promise<CacheMeta | null> {
    const bytes = await this.readRawBytes(this.metaPath(id))
    if (!bytes) return null
    try {
      const json = new TextDecoder().decode(new Uint8Array(bytes))
      return JSON.parse(json) as CacheMeta
    } catch (e) {
      console.warn(`[CacheFS] 元数据解析失败: ${id}`, e)
      return null
    }
  }

  /**
   * 读取所有归档元数据，按 lastAccessed 升序排列
   * @returns 元数据数组，读取失败时返回空数组
   */
  async loadAllMeta(): Promise<CacheMeta[]> {
    const entries = await this.listMetaEntries()
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

  /**
   * 删除指定路径的文件（不存在时忽略，其他错误记录警告）
   * @param path - 文件路径
   * @param label - 日志标识（用于警告信息）
   */
  private async deleteFileSafe(path: string, label: string): Promise<void> {
    const fn = await getInvoke()
    try {
      await fn('delete_file', { path })
    } catch (e) {
      console.warn(`[CacheFS] 删除${label}失败: ${path}`, e)
    }
  }

  /**
   * 列出 meta 目录下的所有 .json 条目
   * @returns 条目数组，读取失败时返回空数组
   */
  private async listMetaEntries(): Promise<Array<{ name: string; isDirectory: boolean }>> {
    const fn = await getInvoke()
    const metaDir = joinPath(this.cacheDir, 'meta')
    try {
      return await fn('list_files', { dir: metaDir })
    } catch (e) {
      console.warn('[CacheFS] 读取元数据目录失败', e)
      return []
    }
  }

  /**
   * 删除归档元数据文件
   * @param id - 归档 id
   */
  async deleteMeta(id: string): Promise<void> {
    await this.deleteFileSafe(this.metaPath(id), '元数据')
  }

  /**
   * 保存归档二进制数据
   * @param id - 归档 id
   * @param data - 字节数组
   */
  async saveFileData(id: string, data: Uint8Array): Promise<void> {
    const fn = await getInvoke()
    await fn('write_file', { path: this.dataPath(id), data: Array.from(data) })
  }

  /**
   * 读取归档二进制数据
   * @param id - 归档 id
   * @returns 字节数组，不存在或读取出错时返回 null
   */
  async loadFileData(id: string): Promise<Uint8Array | null> {
    const bytes = await this.readRawBytes(this.dataPath(id))
    return bytes ? new Uint8Array(bytes) : null
  }

  /**
   * 删除归档二进制数据文件
   * @param id - 归档 id
   */
  async deleteFileData(id: string): Promise<void> {
    await this.deleteFileSafe(this.dataPath(id), '数据文件')
  }

  /**
   * 列出所有已缓存的归档 id
   * @returns 归档 id 字符串数组，读取失败时返回空数组
   */
  async listIds(): Promise<string[]> {
    const entries = await this.listMetaEntries()
    return entries
      .filter(e => !e.isDirectory && e.name.endsWith('.json'))
      .map(e => e.name.replace(/\.json$/, ''))
  }
}
