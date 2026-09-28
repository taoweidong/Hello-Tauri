/**
 * CLI 输出的归一化适配器（设计 §3.3：与 `commands.ts` 一起，是真实接口的唯一改动面）。
 *
 * 职责：把 CLI 的 JSON 输出翻译成领域类型（`NormalizedMessage` 等）。
 * 三条设计立场：
 *
 *  1. **宽进严出**：字段名容错（`msgId`/`msg_id`/`id` 都认），因为 CLI 的实际字段名
 *     未知；但输出必须严格符合领域类型，缺关键字段就抛 `parse` 错 —— 静默产出
 *     半成品消息比报错更糟（错误数据会污染存档与语料）。
 *  2. **@我 的识别**：假设 CLI 提供 `atMe` 布尔；若只给 `atList`（被 @ 的工号数组），
 *     则用 `myUserId` 判定。**@所有人 不算 @我**（Q5）—— 因此要排除 `atAll`/`@所有人` 标记。
 *  3. **非 text 消息**：仅占位存档（设计 §7.1），内容替换成 `[图片]` 这类描述，
 *     而不是丢弃 —— R2 要求「所有私聊消息」可查。
 */
import type { NormalizedMessage, WelinkConversation, WelinkConvType } from '@/types/welink'
import { nowStamp } from '@/utils/time'
import { WelinkError } from './port'

/** 从任意对象里按候选键名取值（宽进：CLI 字段名未知） */
function pick(source: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) {
    if (source[key] !== undefined && source[key] !== null) return source[key]
  }
  return undefined
}

function pickString(source: Record<string, unknown>, keys: string[], fallback = ''): string {
  const value = pick(source, keys)
  if (value === undefined) return fallback
  return typeof value === 'string' ? value : String(value)
}

function pickArray(source: Record<string, unknown>, keys: string[]): unknown[] {
  const value = pick(source, keys)
  return Array.isArray(value) ? value : []
}

/** 解析顶层 JSON；失败统一归 `parse`（重试无意义） */
export function parseJson<T>(raw: string, context: string): T {
  const text = raw.trim()
  if (!text) throw new WelinkError(`${context}：输出为空`, 'parse')
  try {
    return JSON.parse(text) as T
  } catch (error) {
    throw new WelinkError(`${context}：输出不是合法 JSON（前 160 字符：${text.slice(0, 160)}）`, 'parse', error)
  }
}

/** CLI 输出的时间格式不一（秒级/毫秒级/ISO），统一归一为 `YYYY-MM-DD HH:mm:ss` 本地串 */
function normalizeTime(value: unknown): string {
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value)) {
    // ISO 带 T 的直接替换成空格并截到秒；已经是目标格式的原样返回
    return value.replace('T', ' ').slice(0, 19)
  }
  const numeric = typeof value === 'number' ? value : Number(value)
  if (Number.isFinite(numeric) && numeric > 0) {
    // 10 位当秒、13 位当毫秒（CLI 两种都可能给）
    const ms = numeric < 1e12 ? numeric * 1000 : numeric
    const date = new Date(ms)
    if (!Number.isNaN(date.getTime())) return nowStamp(date)
  }
  return nowStamp()
}

/** 非 text 消息的占位描述（设计 §7.1：占位存档，不参与回复） */
function placeholderFor(msgType: string): string {
  const map: Record<string, string> = {
    image: '[图片]',
    file: '[文件]',
    audio: '[语音]',
    video: '[视频]',
    system: '[系统消息]',
    location: '[位置]',
  }
  return map[msgType] ?? `[${msgType || '非文本'}消息]`
}

export interface ParseContext {
  /** 当前用户工号：判定 @我 + 过滤自发消息（防自回复循环） */
  myUserId: string
  /** 拉取目标（CLI 输出可能不含会话信息，用请求参数兜底） */
  convId: string
  convType: WelinkConvType
}

/**
 * 归一化一条原始消息。
 *
 * 判定顺序很重要：先定 `direction`（自发消息一律 out），再定 `atMe`
 * —— 自己发的消息永远不可能「@我」，这个短路避免实现方把 atList 里的自己算进去。
 */
export function normalizeMessage(raw: Record<string, unknown>, context: ParseContext): NormalizedMessage {
  const senderId = pickString(raw, ['senderId', 'sender_id', 'fromId', 'from', 'sender'])
  const msgType = (pickString(raw, ['msgType', 'msg_type', 'type'], 'text') || 'text').toLowerCase()
  const rawContent = pickString(raw, ['content', 'text', 'body'])
  const direction = senderId && senderId === context.myUserId ? 'out' : 'in'

  // @我 判定：显式 atMe 优先；否则看被 @ 的工号列表里是否含我；
  // @所有人 单独标记（Q5：不算 @我 —— 否则每个群公告都会触发一轮回复）
  const atAll = Boolean(pick(raw, ['atAll', 'at_all', 'mentionAll']))
  const explicitAtMe = pick(raw, ['atMe', 'at_me', 'mentioned'])
  const atList = pickArray(raw, ['atList', 'at_list', 'mentions', 'atUsers']).map((item) =>
    typeof item === 'string' ? item : pickString(item as Record<string, unknown>, ['id', 'userId', 'empNo']),
  )
  const atMe =
    direction === 'in' && !atAll && (explicitAtMe === true || (!!context.myUserId && atList.includes(context.myUserId)))

  const msgUid = pickString(raw, ['msgUid', 'msg_uid', 'msgId', 'msg_id', 'id', 'uuid'])
  if (!msgUid) {
    // 没有稳定 UID 就无法幂等去重（会重复回复），这是硬错误
    throw new WelinkError('消息缺少唯一标识（msgUid/msgId/id），无法保证幂等', 'parse')
  }

  return {
    msgUid,
    convType: context.convType,
    convId: pickString(raw, ['convId', 'conv_id', 'chatId', 'groupId'], context.convId),
    direction,
    senderId,
    senderName: pickString(raw, ['senderName', 'sender_name', 'fromName', 'nickname']),
    content: msgType === 'text' ? rawContent : placeholderFor(msgType),
    msgType,
    atMe,
    sentAt: normalizeTime(pick(raw, ['sentAt', 'sent_at', 'timestamp', 'time', 'createTime'])),
  }
}

/** `pull` 输出解析：兼容 `{messages, cursor, hasMore}` 与直接给数组两种形状 */
export function parsePullOutput(
  raw: string,
  context: ParseContext,
): { messages: NormalizedMessage[]; cursor: string; hasMore: boolean } {
  const parsed = parseJson<unknown>(raw, 'pull')
  const container = (Array.isArray(parsed) ? { messages: parsed } : (parsed as Record<string, unknown>)) ?? {}
  const items = Array.isArray(container)
    ? (container as unknown[])
    : pickArray(container as Record<string, unknown>, ['messages', 'items', 'list', 'data'])
  const cursor = pickString(container as Record<string, unknown>, ['cursor', 'nextCursor', 'next', 'lastCursor'])
  const hasMore = Boolean(pick(container as Record<string, unknown>, ['hasMore', 'has_more', 'more']))
  return {
    messages: items.map((item) => normalizeMessage(item as Record<string, unknown>, context)),
    cursor,
    hasMore,
  }
}

/** `list` 输出解析：兼容 `{conversations|groups|contacts}` 与数组 */
export function parseListOutput(raw: string): WelinkConversation[] {
  const parsed = parseJson<unknown>(raw, 'list')
  const items = Array.isArray(parsed)
    ? parsed
    : pickArray(parsed as Record<string, unknown>, ['conversations', 'groups', 'contacts', 'items', 'list'])
  return items.map((item, index) => {
    const raw = item as Record<string, unknown>
    const convType = (
      pickString(raw, ['convType', 'conv_type', 'type'], 'group').toLowerCase() === 'private' ? 'private' : 'group'
    ) as WelinkConvType
    return {
      pk: index + 1,
      convType,
      convId: pickString(raw, ['convId', 'conv_id', 'id', 'empNo', 'groupId']),
      title: pickString(raw, ['title', 'name', 'nickname']),
      remark: '',
      watching: false,
      autoReply: false,
      muteUntil: null,
      lastMsgAt: '',
      unreadCount: Number(pick(raw, ['unreadCount', 'unread']) ?? 0) || 0,
      mentionCount: 0,
      lastActive: '',
      lastCursor: '',
      updatedAt: nowStamp(),
    } satisfies WelinkConversation
  })
}

/** `send` 输出解析：取回执里的 msgUid（缺失时用「会话+内容+时间」派生，保证幂等键稳定） */
export function parseSendOutput(raw: string, fallbackSeed: string): string {
  const parsed = parseJson<Record<string, unknown>>(raw, 'send')
  const uid = pickString(parsed, ['msgUid', 'msg_uid', 'msgId', 'msg_id', 'id'])
  return uid || `local-${fallbackSeed}`
}
