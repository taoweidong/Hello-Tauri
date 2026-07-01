export type LogLevel = 'INFO' | 'DEBUG' | 'WARN' | 'ERROR' | 'OTHER'

export interface LogLine {
  lineNumber: number
  timestamp: string
  level: LogLevel
  module: string
  message: string
  raw: string
}
