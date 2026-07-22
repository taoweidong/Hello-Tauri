/**
 * 插件公共工具函数
 * 提取各解析/压缩插件中的重复逻辑，包括：
 * - 文本解码
 * - CSV 解码+解析
 * - 扩展名匹配 canParse 工厂
 * - Tauri 平台适配器获取
 */
import type { FileEntry, DecompressResult } from '@/types'
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

/**
 * 获取 Tauri 平台适配器（压缩插件共用的平台判断 + 动态导入逻辑）
 * 仅在 __PLATFORM__ === 'tauri' 时返回适配器，否则返回 null
 * @returns 平台适配器或 null
 */
export async function getTauriAdapter(): Promise<import('@/adapters/types').IPlatformAdapter | null> {
  if (__PLATFORM__ !== 'tauri') return null
  const { usePlatform } = await import('@/composables/use-platform')
  const { getAdapter } = usePlatform()
  return getAdapter()
}

/**
 * 通过 Tauri 后端执行解压（gzip/zip 压缩插件共用的 Tauri 分支逻辑）
 * @param data - 压缩包字节数据
 * @param format - 压缩格式标识（'gzip' | 'zip'）
 * @param outputDir - 输出目录
 * @param outputName - 输出文件名（可选）
 * @returns 解压结果，非 Tauri 平台时返回 null
 */
export async function decompressViaTauri(
  data: Uint8Array,
  format: string,
  outputDir: string,
  outputName?: string,
): Promise<DecompressResult | null> {
  const adapter = await getTauriAdapter()
  if (!adapter) return null
  return adapter.decompress(data, format, outputDir, outputName)
}
