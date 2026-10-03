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
 * 敏感值遮蔽注册表（design D6：CodeHub token 全链路脱敏的**最后一道闸**）。
 *
 * 配置装载/保存处把 token 值注册进来，日志出口对所有消息做等值替换 —— 即使
 * 某处日志拼接漏了脱敏（比如错误串里带了完整参数），已注册的敏感值也不会落到
 * 控制台、日志文件与 UI 运行日志区。空串与过短值（<4 字符）不注册：
 * 短串等值替换的误伤面大于收益。
 */
const secrets = new Set<string>()

export function registerSecret(value: string | null | undefined): void {
  const trimmed = value?.trim()
  if (trimmed && trimmed.length >= 4) secrets.add(trimmed)
}

/** 测试用：清空遮蔽注册表 */
export function resetSecretsForTest(): void {
  secrets.clear()
}

function maskSecrets(message: string): string {
  let masked = message
  for (const secret of secrets) {
    if (masked.includes(secret)) masked = masked.split(secret).join('***')
  }
  return masked
}

/**
 * 注册日志旁路。返回退订函数（组件/store 卸载时调用，避免悬挂引用）。
 *
 * 转发是**同步**的：日志顺序即事件顺序，UI 里「失败原因」不会跑到「重试」后面。
 */
export function onLog(sink: LogSink): () => void {
  sinks.add(sink)
  return () => sinks.delete(sink)
}

function emit(level: LogLevel, rawMessage: string) {
  const message = maskSecrets(rawMessage)
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

/** 异常对象会附带消息与堆栈，便于定位（warn/error 同款语义） */
function withDetail(message: string, error?: unknown): string {
  const detail = error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : error ? String(error) : ''
  return detail ? `${message} :: ${detail}` : message
}

export const logger = {
  info: (message: string) => emit('info', message),
  warn: (message: string, error?: unknown) => emit('warn', withDetail(message, error)),
  error: (message: string, error?: unknown) => emit('error', withDetail(message, error)),
}
