import type { ParsedResult } from '@/plugins/types'
import type { CsvData } from '@/types'

/**
 * 解析单行 CSV 文本，支持引号包裹的字段（含逗号、换行等）
 * @param line - 单行 CSV 文本
 * @param delimiter - 字段分隔符
 * @returns 解析后的字段数组
 */
function parseLine(line: string, delimiter: string): string[] {
  const fields: string[] = []
  let current = ''
  let inQuotes = false
  let i = 0

  while (i < line.length) {
    const ch = line[i]
    if (inQuotes) {
      if (ch === '"') {
        // 双引号转义
        if (i + 1 < line.length && line[i + 1] === '"') {
          current += '"'
          i += 2
        } else {
          inQuotes = false
          i++
        }
      } else {
        current += ch
        i++
      }
    } else {
      if (ch === '"') {
        inQuotes = true
        i++
      } else if (line.substring(i, i + delimiter.length) === delimiter) {
        fields.push(current)
        current = ''
        i += delimiter.length
      } else {
        current += ch
        i++
      }
    }
  }
  fields.push(current)
  return fields.map(f => f.trim())
}

/**
 * 解析 CSV 文本为结构化数据
 * 支持引号包裹的字段（包含分隔符、双引号转义）
 * @param text - CSV 文本内容
 * @param delimiter - 字段分隔符，默认 ','
 * @returns 解析结果（包含表头与数据行）
 */
export function parseCsv(text: string, delimiter = ','): ParsedResult {
  const lines = text.split('\n').filter(line => line.trim().length > 0)
  if (lines.length === 0) {
    return { type: 'csv', data: { headers: [], rows: [] }, lineCount: 1 }
  }
  const headers = parseLine(lines[0], delimiter)
  const rows = lines.slice(1).map(line => parseLine(line, delimiter))
  return { type: 'csv', data: { headers, rows }, lineCount: rows.length + 1 }
}
