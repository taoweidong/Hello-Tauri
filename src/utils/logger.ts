import { bridge } from '@/api'
import type { LogLevel } from '@/types'

/**
 * 统一日志出口：同时写控制台与宿主日志文件（D:\TangYuan\logs）。
 * 日志本身失败不阻断业务，因此这里吞掉所有异常。
 */
function emit(level: LogLevel, message: string) {
  const consoleMethod = level === 'error' ? console.error : level === 'warn' ? console.warn : console.info
  consoleMethod(`[${level}] ${message}`)

  void bridge.appendLog(level, message).catch(() => {
    // 日志通道不可用时只静默降级，避免影响业务与造成递归报错
  })
}

export const logger = {
  info: (message: string) => emit('info', message),
  warn: (message: string) => emit('warn', message),
  /** 异常对象会附带堆栈，便于定位 */
  error: (message: string, error?: unknown) => {
    const detail = error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : error ? String(error) : ''
    emit('error', detail ? `${message} :: ${detail}` : message)
  },
}