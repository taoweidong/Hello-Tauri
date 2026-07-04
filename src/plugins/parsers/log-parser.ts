import type { ParsedResult } from '@/plugins/types'
import type { LogLine, LogLevel } from './types'

const LOG_RE = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\s+\[(\w+)\]\s*\[([\w-]+)\]\s*(.*)$/

function normalizeLevel(s: string): LogLevel {
  if (s === 'INFO' || s === 'DEBUG' || s === 'WARN' || s === 'ERROR') return s
  return 'OTHER'
}

export function parseLog(data: Uint8Array, encoding = 'utf-8'): ParsedResult {
  const text = new TextDecoder(encoding).decode(data)
  const lines = text.length === 0 ? [] : text.split('\n')
  const result: LogLine[] = lines.map((line, i) => {
    const m = line.match(LOG_RE)
    if (m) {
      return {
        lineNumber: i + 1,
        timestamp: m[1],
        level: normalizeLevel(m[2]),
        module: m[3],
        message: m[4],
        raw: line,
      }
    }
    return {
      lineNumber: i + 1,
      timestamp: '',
      level: 'OTHER',
      module: '',
      message: '',
      raw: line,
    }
  })
  return { type: 'log', data: result, lineCount: lines.length }
}
