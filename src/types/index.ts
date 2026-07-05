/** 文件条目，描述压缩包内的单个文件或目录 */
export interface FileEntry {
  /** 文件名称 */
  name: string
  /** 文件路径（相对于压缩包根目录） */
  path: string
  /** 文件大小（字节） */
  size: number
  /** 是否为目录 */
  isDirectory: boolean
  /** 最后修改时间戳（毫秒） */
  lastModified?: number
}

/** 解压操作结果 */
export interface DecompressResult {
  /** 是否解压成功 */
  success: boolean
  /** 解压后的文件列表 */
  files: FileEntry[]
  /** 失败时的错误信息 */
  error?: string
}

/** 压缩包处理状态 */
export type ArchiveStatus = 'pending' | 'running' | 'completed' | 'failed'

/** 文件树节点，用于 UI 树形组件展示 */
export interface FileTreeNode {
  /** 节点唯一键（通常为文件路径） */
  key: string
  /** 显示名称 */
  label: string
  /** 是否为叶子节点（文件） */
  isLeaf: boolean
  /** 文件路径 */
  path: string
  /** 文件大小（字节），目录无此字段 */
  size?: number
  /** 子节点列表，仅目录有值 */
  children?: FileTreeNode[]
}

/** 日志级别枚举 */
export type LogLevel = 'INFO' | 'DEBUG' | 'WARN' | 'ERROR' | 'OTHER'

/** 解析后的单行日志数据 */
export interface LogLine {
  /** 行号（从 1 开始） */
  lineNumber: number
  /** 时间戳字符串 */
  timestamp: string
  /** 日志级别 */
  level: LogLevel
  /** 模块名称 */
  module: string
  /** 日志消息 */
  message: string
  /** 原始行文本 */
  raw: string
}

/** CSV 解析结果数据结构 */
export interface CsvData {
  /** 表头列名数组 */
  headers: string[]
  /** 数据行，每行为字符串数组 */
  rows: string[][]
}

/** 解析结果判别联合类型：根据 type 字段可精确推断 data 类型 */
export type ParsedContent =
  | { type: 'text'; data: string; lineCount?: number; loadTimeMs?: number; pluginName?: string; encoding?: string; size?: number }
  | { type: 'csv'; data: CsvData; lineCount?: number; loadTimeMs?: number; pluginName?: string; encoding?: string; size?: number }
  | { type: 'json'; data: unknown; lineCount?: number; loadTimeMs?: number; pluginName?: string; encoding?: string; size?: number }
  | { type: 'hex'; data: Uint8Array; lineCount?: number; loadTimeMs?: number; pluginName?: string; encoding?: string; size?: number }
  | { type: 'log'; data: LogLine[]; lineCount?: number; loadTimeMs?: number; pluginName?: string; encoding?: string; size?: number }

/** 归档项，表示一个已上传或缓存恢复的压缩包 */
export interface ArchiveItem {
  /** 归档唯一标识 */
  id: string
  /** 归档文件名 */
  name: string
  /** 原始 File 对象，仅在当次会话上传时有值；缓存恢复时为 undefined */
  file?: File
  /** 缓存 key，用于从 CacheStorage 读取数据 */
  cacheId: string
  /** 当前处理状态 */
  status: ArchiveStatus
  /** 处理进度百分比（0-100） */
  progress: number
  /** 已解压的文件树 */
  files: FileTreeNode[]
  /** 错误信息（失败时） */
  error?: string
  /** 开始处理的时间戳 */
  startTime?: number
  /** 处理完成的时间戳 */
  endTime?: number
  /** 解压后原始大小（字节） */
  originalSize: number
  /** 压缩包大小（字节） */
  compressedSize: number
}

/** 标签页项，表示一个已打开的文件预览标签 */
export interface TabItem {
  /** 标签页唯一标识 */
  id: string
  /** 关联的文件树节点 */
  fileNode: FileTreeNode
  /** 所属归档的 id */
  archiveId: string
  /** 是否已固定（固定标签不被批量关闭） */
  pinned: boolean
  /** 已解析的文件内容 */
  content?: ParsedContent
}

/** 单条搜索结果匹配项 */
export interface SearchMatch {
  /** 所属归档 id */
  archiveId: string
  /** 文件路径 */
  filePath: string
  /** 文件名 */
  fileName: string
  /** 匹配所在行号 */
  lineNumber: number
  /** 匹配所在行的完整内容 */
  lineContent: string
  /** 匹配起始字符位置 */
  matchStart: number
  /** 匹配结束字符位置 */
  matchEnd: number
}

/** 搜索结果集合 */
export interface SearchResults {
  /** 搜索关键字 */
  keyword: string
  /** 所有匹配项列表 */
  matches: SearchMatch[]
  /** 搜索耗时（毫秒） */
  searchTimeMs: number
}
