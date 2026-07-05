import type { ParsedResult } from '@/plugins/types'
import type { LogLine, LogLevel } from './types'

/** 标准日志行正则表达式（匹配时间戳 + 级别 + 模块 + 消息） */
const LOG_RE = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\s+\[(\w+)\]\s*\[([\w-]+)\]\s*(.*)$/

/**
 * 将字符串级别标准化为 LogLevel 枚举
 * @param s - 原始级别字符串
 * @returns 标准化的日志级别
 */
function normalizeLevel(s: string): LogLevel {
  if (s === 'INFO' || s === 'DEBUG' || s === 'WARN' || s === 'ERROR') return s
  return 'OTHER'
}

/**
 * 解析日志文件字节数据为结构化日志行数组
 * @param data - 日志文件字节数据
 * @param encoding - 字符编码，默认 'utf-8'
 * @returns 解析结果（包含结构化日志行列表）
 */
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
