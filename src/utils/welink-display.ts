/**
 * WeLink 展示层的纯函数（T-4：把组件里的展示逻辑收出来，可测、唯一真值）。
 *
 * ## 为什么要把这些搬出组件
 *
 * 抽取的直接动因不是「文件太长」，而是**同一概念出现过多份实现，且它们互相不一致**：
 *
 *  | 概念         | 抽取前的位置                                                     | 不一致之处                                                     |
 *  | ------------ | ---------------------------------------------------------------- | -------------------------------------------------------------- |
 *  | 静音剩余文案 | `ConfigTab.muteLabel` / `MessagesTab.muteLabel`                   | 前者 `09-28 10:30`、后者 `10:30`；过期判定一个解析日期一个比字符串 |
 *  | 时间列文案   | `HistoryTab` / `InboxTab` / `MessagesTab` / `TraceTab` 各写一份    | 空值有的给 `-` 有的给空串                                        |
 *
 * 这类「展示口径漂移」不会报错、不会崩溃，只会让同一份数据在两个页面显示成两个样子 ——
 * 属于典型的「不出事故但持续钝化」。收敛到一处后，行为由单测钉住。
 *
 * 这里只放**纯函数**（无 Vue 依赖、无 store 依赖、无副作用），因此可以直接单测，
 * 也可以被 store / 组件 / 将来的其他地方复用。
 */
import { parseStamp } from './time'

/** 时间戳 → `MM-DD HH:mm`（列表里的紧凑时间列） */
export function shortStamp(stamp: string | null | undefined, fallback = '-'): string {
  return stamp ? stamp.slice(5, 16) : fallback
}

/** 时间戳 → `HH:mm`（当天内的时刻，用于静音到期提示） */
export function clockStamp(stamp: string | null | undefined, fallback = '-'): string {
  return stamp ? stamp.slice(11, 16) : fallback
}

/**
 * 静音剩余文案（O11）。
 *
 * 统一口径：**未静音或已到期一律返回空串**，调用方据此决定是否展示提示与置灰行 ——
 * 所以「是否有值」本身就是「是否处于静音中」的判据，不需要第二个函数。
 *
 * 到期判定用 `parseStamp`（本地时间）而不是字符串比较：字符串比较在
 * `mute_until` 与当前时间格式不完全一致时（比如少了秒）会静默给出错误结论，
 * 而 `parseStamp` 对非法输入返回 `null`，语义是明确的「不认为在静音中」。
 *
 * @param withDate `true` 时输出 `MM-DD HH:mm`（跨天场景更需要日期），
 *                 `false` 时只输出 `HH:mm`。
 */
export function muteLabel(muteUntil: string | null | undefined, now: Date = new Date(), withDate = true): string {
  const parsed = parseStamp(muteUntil)
  if (!parsed) return ''
  // 已到期 → 不再提示（与「静音中」是互斥状态）
  if (parsed.getTime() <= now.getTime()) return ''
  return `静音至 ${withDate ? shortStamp(muteUntil) : clockStamp(muteUntil)}`
}

/** 是否处于静音中（`muteLabel` 有值即静音中，保持单一判据） */
export function isMuted(muteUntil: string | null | undefined, now: Date = new Date()): boolean {
  return muteLabel(muteUntil, now) !== ''
}

/** 毫秒的可读格式化（`300ms` / `1.5s` / `2s`） */
export function formatMs(ms: number): string {
  if (ms >= 1000) {
    // 整数秒不显示小数点：1500 → 1.5s，2000 → 2s（避免「2.0s」这种噪音）
    return `${(ms / 1000).toFixed(ms % 1000 === 0 ? 0 : 1)}s`
  }
  return `${ms}ms`
}

/** 秒的可读格式化，保留一位小数（`5.0s`） */
export function formatSec(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`
}
