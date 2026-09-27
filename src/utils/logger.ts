import { bridge } from '@/api'
import type { LogLevel } from '@/types'

/**
 * 统一日志出口：同时写控制台与宿主日志文件（D:\TangYuan\logs）。
 * 日志本身失败不阻断业务，因此这里吞掉所有异常。
 *
 * **旁路订阅（P10）**：UI 的运行日志区不读日志文件，而是订阅这里的内存转发 ——
 * 否则编排层（poller/pipeline）的 warn/error 只落到文件与控制台，用户在页面上
 * 看不到「刚才为什么失败」。「日志与渲染解耦」的原意是**不落库、不刷屏**，
 * 不是「不让用户看见」：环形缓冲（200 行）留在订阅方（store），这里只负责转发。
 */
type LogSink = (level: LogLevel, message: string) => void
const sinks = new Set<LogSink>()

/**
 * 注册日志旁路。返回退订函数（组件/store 卸载时调用，避免悬挂引用）。
 *
 * 转发是**同步**的：日志顺序即事件顺序，UI 里「失败原因」不会跑到「重试」后面。
 */
export function onLog(sink: LogSink): () => void {
  sinks.add(sink)
  return () => sinks.delete(sink)
}

function emit(level: LogLevel, message: string) {
  const consoleMethod = level === 'error' ? console.error : level === 'warn' ? console.warn : console.info
  consoleMethod(`[${level}] ${message}`)

  void bridge.appendLog(level, message).catch(() => {
    // 日志通道不可用时只静默降级，避免影响业务与造成递归报错
  })

  for (const sink of sinks) {
    try {
      sink(level, message)
    } catch {
      // 订阅方自己的异常不能反过来打断日志链路
    }
  }
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