export interface FileEntry {
  name: string
  path: string
  size: number
  isDirectory: boolean
  lastModified?: number
}

export interface DecompressResult {
  success: boolean
  files: FileEntry[]
  error?: string
}

export type ArchiveStatus = 'pending' | 'running' | 'completed' | 'failed'

export interface FileTreeNode {
  key: string
  label: string
  isLeaf: boolean
  path: string
  size?: number
  children?: FileTreeNode[]
}

export interface ParsedContent {
  type: 'text' | 'csv' | 'json' | 'hex' | 'log'
  data: any
  lineCount?: number
  loadTimeMs?: number
  pluginName: string
}

export interface ArchiveItem {
  id: string
  name: string
  /** 原始 File 对象，仅在当次会话上传时有值；缓存恢复时为 undefined */
  file?: File
  /** 缓存 key，用于从 CacheStorage 读取数据 */
  cacheId: string
  status: ArchiveStatus
  progress: number
  files: FileTreeNode[]
  error?: string
  startTime?: number
  endTime?: number
  originalSize: number
  compressedSize: number
}

export interface TabItem {
  id: string
  fileNode: FileTreeNode
  archiveId: string
  pinned: boolean
  content?: ParsedContent
}

export interface SearchMatch {
  archiveId: string
  filePath: string
  fileName: string
  lineNumber: number
  lineContent: string
  matchStart: number
  matchEnd: number
}

export interface SearchResults {
  keyword: string
  matches: SearchMatch[]
  searchTimeMs: number
}
