import type { ParsedResult } from '@/plugins/types'

/**
 * 解析 JSON 文本，支持标准 JSON 与 JSONL 格式
 * @param text - JSON 文本内容
 * @returns 解析结果
 * @throws 解析失败时抛出错误
 */
export function parseJson(text: string): ParsedResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    try {
      parsed = text.split('\n').filter(l => l.trim()).map(line => JSON.parse(line))
    } catch (err) {
      throw new Error(`Invalid JSON: ${err instanceof Error ? err.message : 'parse error'}`)
    }
  }
  const formatted = JSON.stringify(parsed, null, 2)
  return { type: 'json', data: parsed, lineCount: formatted.split('\n').length }
}
