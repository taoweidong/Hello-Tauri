/**
 * 缓存存储层接口定义
 * 屏蔽 Web（IndexedDB）与 Tauri（文件系统）两种后端差异
 */
import type { ArchiveStatus, FileTreeNode } from '@/types'

/** 归档元数据（不含二进制），用于快速恢复归档列表 */
export interface CacheMeta {
  id: string
  name: string
  /** 原始文件大小（字节） */
  size: number
  /** 文件 lastModified 时间戳 */
  lastModified: number
  status: ArchiveStatus
  /** 已解压的文件树 */
  files: FileTreeNode[]
  originalSize: number
  compressedSize: number
  startTime?: number
  endTime?: number
  error?: string
  /** LRU 时间戳，每次访问时更新 */
  lastAccessed: number
}

/**
 * 缓存存储抽象接口
 * - Web 端实现：IndexedDB
 * - Tauri 端实现：本地文件系统
 */
export interface ICacheStorage {
  /** 初始化存储（建库/建目录） */
  init(): Promise<void>

  /** 保存归档元数据 */
  saveMeta(id: string, meta: CacheMeta): Promise<void>

  /** 读取单个归档元数据，不存在时返回 null */
  loadMeta(id: string): Promise<CacheMeta | null>

  /** 读取所有归档元数据，按 lastAccessed 升序排列（最旧在前） */
  loadAllMeta(): Promise<CacheMeta[]>

  /** 删除归档元数据 */
  deleteMeta(id: string): Promise<void>

  /** 保存归档的原始二进制文件数据 */
  saveFileData(id: string, data: Uint8Array): Promise<void>

  /** 读取归档二进制数据，不存在时返回 null */
  loadFileData(id: string): Promise<Uint8Array | null>

  /** 删除归档二进制数据 */
  deleteFileData(id: string): Promise<void>

  /** 列出所有已缓存的归档 id */
  listIds(): Promise<string[]>
}
