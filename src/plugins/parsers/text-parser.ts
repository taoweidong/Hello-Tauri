import type { ParsedResult } from '@/plugins/types'

/**
 * 解析纯文本文件字节数据
 * @param data - 文件字节数据
 * @param encoding - 字符编码，默认 'utf-8'
 * @returns 解析结果（包含文本内容与行数）
 */
export function parseText(data: Uint8Array, encoding = 'utf-8'): ParsedResult {
  const text = new TextDecoder(encoding).decode(data)
  const lineCount = text.length === 0 ? 0 : text.split('\n').length
  return { type: 'text', data: text, lineCount }
}
