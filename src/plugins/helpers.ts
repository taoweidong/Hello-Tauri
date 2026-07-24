/**
 * 插件公共工具函数
 * 提取各解析/压缩插件中的重复逻辑，包括：
 * - 文本解码
 * - CSV 解码+解析
 * - 扩展名匹配 canParse 工厂
 */
import type { FileEntry } from '@/types'
import type { ParsedResult } from './types'
import { parseCsv } from './parsers/csv-parser'

/**
 * 将字节数据解码为文本字符串
 * @param data - 文件字节数据
 * @param encoding - 字符编码，默认 'utf-8'
 * @returns 解码后的文本
 */
export function decodeText(data: Uint8Array, encoding = 'utf-8'): string {
  return new TextDecoder(encoding).decode(data)
}

/**
 * 解码字节数据并解析为 CSV 结构（csv-plugin 与 table-tree-plugin 共用）
 * @param data - 文件字节数据
 * @param options - 解析选项（encoding、delimiter）
 * @returns CSV 解析结果
 */
export function decodeAndParseCsv(data: Uint8Array, options?: Record<string, any>): ParsedResult {
  const text = decodeText(data, options?.encoding ?? 'utf-8')
  const delimiter = options?.delimiter ?? ','
  return parseCsv(text, delimiter)
}

/**
 * 创建基于扩展名匹配的 canParse 函数（消除多插件重复的 matchesAnyExtension 调用模式）
 * @param extensions - 支持的扩展名列表（含前导点）
 * @returns canParse 函数
 */
export function createExtensionMatcher(extensions: string[]): (file: FileEntry) => boolean {
  return (file: FileEntry) => extensions.some(ext => file.name.endsWith(ext))
}
