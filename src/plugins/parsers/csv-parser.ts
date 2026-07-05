import type { ParsedResult } from '@/plugins/types'

/** CSV 解析结果数据结构 */
export interface CsvData {
  /** 表头列名数组 */
  headers: string[]
  /** 数据行，每行为字符串数组 */
  rows: string[][]
}

/**
 * 解析 CSV 文本为结构化数据
 * @param text - CSV 文本内容
 * @param delimiter - 字段分隔符，默认 ','
 * @returns 解析结果（包含表头与数据行）
 */
export function parseCsv(text: string, delimiter = ','): ParsedResult {
  const lines = text.split('\n').filter(line => line.trim().length > 0)
  if (lines.length === 0) {
    return { type: 'csv', data: { headers: [], rows: [] }, lineCount: 1 }
  }
  const headers = lines[0].split(delimiter).map(s => s.trim())
  const rows = lines.slice(1).map(line => line.split(delimiter).map(s => s.trim()))
  return { type: 'csv', data: { headers, rows }, lineCount: rows.length + 1 }
}
