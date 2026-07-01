import type { ParsedResult } from '@/plugins/types'

export interface CsvData {
  headers: string[]
  rows: string[][]
}

export function parseCsv(text: string, delimiter = ','): ParsedResult {
  const lines = text.split('\n').filter(line => line.trim().length > 0)
  if (lines.length === 0) {
    return { type: 'csv', data: { headers: [], rows: [] }, lineCount: 1 }
  }
  const headers = lines[0].split(delimiter).map(s => s.trim())
  const rows = lines.slice(1).map(line => line.split(delimiter).map(s => s.trim()))
  return { type: 'csv', data: { headers, rows }, lineCount: rows.length + 1 }
}
