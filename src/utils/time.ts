/**
 * 时间工具（全项目统一出口）。
 *
 * 为什么不用 `toISOString()`：它是 UTC，东八区凌晨会把「今天」记成昨天，
 * 日志、日期列、静默时段判定都会错。这里一律用**本地时间**拼字符串。
 */

/** 本地时间戳，形如 `2026-09-27 23:48:14`（落库用，可直接字符串比较排序） */
export function nowStamp(date: Date = new Date()): string {
  const pad = (value: number, width = 2) => String(value).padStart(width, '0')
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  )
}

/** 本地日期，形如 `2026-09-27` */
export function today(date: Date = new Date()): string {
  return nowStamp(date).slice(0, 10)
}

/** 本地 `HH:mm` */
export function clock(date: Date = new Date()): string {
  return nowStamp(date).slice(11, 16)
}

/** 把时间戳解析为 Date；非法输入返回 null（不抛，调用方多处是配置/DB 值） */
export function parseStamp(value: string | null | undefined): Date | null {
  if (!value) return null
  const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(value)
  if (!match) return null
  const [, year, month, day, hour, minute, second] = match
  return new Date(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second))
}

/** 时间戳差值（毫秒）；任一不可解析返回 fallback */
export function diffMs(from: string | null, to: string | null, fallback = 0): number {
  const start = parseStamp(from)
  const end = parseStamp(to)
  if (!start || !end) return fallback
  return end.getTime() - start.getTime()
}

/** 相对现在的最小值（用于「草稿已超 4h」这类判定） */
export function isOlderThan(stamp: string | null, limitMs: number, now: Date = new Date()): boolean {
  const parsed = parseStamp(stamp)
  if (!parsed) return false
  return now.getTime() - parsed.getTime() > limitMs
}

/** 把日期/时间戳按小时分组用的键：`2026-09-27 14` */
export function hourBucket(stamp: string): string {
  return stamp.slice(0, 13)
}
