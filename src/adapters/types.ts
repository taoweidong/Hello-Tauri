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

export interface ArchiveItem {
  id: string
  name: string
  file: File
  status: ArchiveStatus
  progress: number
  files: FileTreeNode[]
  error?: string
  startTime?: number
  endTime?: number
  originalSize: number
  compressedSize: number
}

export interface FileTreeNode {
  key: string
  label: string
  isLeaf: boolean
  path: string
  size?: number
  children?: FileTreeNode[]
}

export interface TabItem {
  id: string
  fileNode: FileTreeNode
  archiveId: string
  pinned: boolean
  content?: ParsedContent
}

export interface ParsedContent {
  type: 'text' | 'csv' | 'json' | 'hex' | 'log'
  data: any
  lineCount?: number
  loadTimeMs?: number
  pluginName: string
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

export interface IPlatformAdapter {
  readFile(path: string): Promise<Uint8Array>
  writeFile(path: string, data: Uint8Array): Promise<void>
  listFiles(dir: string): Promise<FileEntry[]>
  getTempDir(): Promise<string>
  decompress(data: Uint8Array, format: string, outputDir: string): Promise<DecompressResult>
  mmapRead(path: string, offset: number, length: number): Promise<Uint8Array>
  streamRead(path: string): ReadableStream<Uint8Array>
}
