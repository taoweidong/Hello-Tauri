/**
 * 轻量日志模块（C2 统一日志治理）
 *
 * 替代生产路径中分散的 console.warn 调用，提供：
 * - 模块前缀标识（[Module] message）
 * - 生产环境仅输出 warn 及以上级别
 * - 开发环境输出全部级别
 */

/** 日志级别枚举 */
type LogLevel = 'debug' | 'info' | 'warn' | 'error'

/** 级别优先级映射 */
const LEVEL_PRIORITY: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 }

/** 当前最低输出级别（生产环境 warn，开发环境 debug） */
const minLevel: LogLevel = import.meta.env?.PROD ? 'warn' : 'debug'

/** 格式化输出 */
function emit(level: LogLevel, prefix: string, args: unknown[]): void {
  if (LEVEL_PRIORITY[level] < LEVEL_PRIORITY[minLevel]) return
  const tag = `[${prefix}]`
  switch (level) {
    case 'debug':
      console.debug(tag, ...args)
      break
    case 'info':
      console.info(tag, ...args)
      break
    case 'warn':
      console.warn(tag, ...args)
      break
    case 'error':
      console.error(tag, ...args)
      break
  }
}

/** 日志器实例接口 */
export interface Logger {
  debug(...args: unknown[]): void
  info(...args: unknown[]): void
  warn(...args: unknown[]): void
  error(...args: unknown[]): void
}

/**
 * 创建带模块前缀的日志器
 * @param module - 模块名称（如 'Archives'、'CacheFS'）
 * @returns 日志器实例
 */
export function createLogger(module: string): Logger {
  return {
    debug: (...args: unknown[]) => emit('debug', module, args),
    info: (...args: unknown[]) => emit('info', module, args),
    warn: (...args: unknown[]) => emit('warn', module, args),
    error: (...args: unknown[]) => emit('error', module, args),
  }
}
