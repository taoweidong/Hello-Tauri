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

export type LogLevel = 'INFO' | 'DEBUG' | 'WARN' | 'ERROR' | 'OTHER'

export interface LogLine {
  lineNumber: number
  timestamp: string
  level: LogLevel
  module: string
  message: string
  raw: string
}

export interface CsvData {
  headers: string[]
  rows: string[][]
}

/** 解析结果判别联合类型：根据 type 字段可精确推断 data 类型 */
export type ParsedContent =
  | { type: 'text'; data: string; lineCount?: number; loadTimeMs?: number; pluginName?: string; encoding?: string; size?: number }
  | { type: 'csv'; data: CsvData; lineCount?: number; loadTimeMs?: number; pluginName?: string; encoding?: string; size?: number }
  | { type: 'json'; data: unknown; lineCount?: number; loadTimeMs?: number; pluginName?: string; encoding?: string; size?: number }
  | { type: 'hex'; data: Uint8Array; lineCount?: number; loadTimeMs?: number; pluginName?: string; encoding?: string; size?: number }
  | { type: 'log'; data: LogLine[]; lineCount?: number; loadTimeMs?: number; pluginName?: string; encoding?: string; size?: number }

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
