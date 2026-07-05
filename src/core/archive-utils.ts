/**
 * 压缩包文件工具函数
 * 集中管理压缩包扩展名判断与文件验证逻辑，避免多处重复定义。
 */
import { getFileValidator } from './file-validator'

/** 支持的压缩包扩展名（小写，含前导点） */
const ACCEPTED_EXTENSIONS = new Set([
  '.zip', '.gz', '.gzip', '.tgz', '.7z', '.rar', '.tar',
])

/** 判断文件名是否为支持的压缩包格式 */
export function isArchiveFile(fileName: string): boolean {
  const ext = fileName.slice(fileName.lastIndexOf('.')).toLowerCase()
  return ACCEPTED_EXTENSIONS.has(ext)
}

/** 从文件列表中过滤出压缩包文件 */
export function filterArchiveFiles(files: File[]): File[] {
  return files.filter(f => isArchiveFile(f.name))
}

/**
 * 对文件列表执行内容验证，返回通过验证的文件。
 * 验证失败时通过 onError 回调通知调用方（用于 UI 提示）。
 */
export async function validateArchiveFiles(
  files: File[],
  onError?: (fileName: string, message: string) => void,
): Promise<File[]> {
  const validator = getFileValidator()
  const valid: File[] = []
  for (const file of files) {
    const result = await validator.validate(file)
    if (result.ok) {
      valid.push(file)
    } else {
      onError?.(file.name, result.message ?? '文件验证未通过')
    }
  }
  return valid
}

/**
 * 统一的压缩包上传处理流程：过滤 → 验证 → 返回有效文件列表。
 * 抽取自 UploadZone 与 use-global-drop 的重复逻辑。
 * @param rawFiles - 原始文件列表
 * @param onError - 单个文件验证失败时的回调
 * @returns 通过验证的压缩包文件列表
 */
export async function processArchiveUpload(
  rawFiles: File[],
  onError?: (fileName: string, message: string) => void,
): Promise<File[]> {
  const archives = filterArchiveFiles(rawFiles)
  if (archives.length === 0) return []
  return validateArchiveFiles(archives, onError)
}
