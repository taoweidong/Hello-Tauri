/** 日志级别枚举 */
export type LogLevel = 'INFO' | 'DEBUG' | 'WARN' | 'ERROR' | 'OTHER'

/** 解析后的单行日志数据 */
export interface LogLine {
  /** 行号（从 1 开始） */
  lineNumber: number
  /** 时间戳字符串 */
  timestamp: string
  /** 日志级别 */
  level: LogLevel
  /** 模块名称 */
  module: string
  /** 日志消息 */
  message: string
  /** 原始行文本 */
  raw: string
}
