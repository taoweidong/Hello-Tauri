/**
 * 提示词渲染（设计 §3.2 / §11.6）。
 *
 * 上下文由**客户端**组装（D3）—— 因为只有客户端知道：目标会话、对方昵称、
 * 最近对话窗口（`maxContextMsgs`）、以及哪条消息触发了本次回复。
 *
 * 渲染规则（UI 上「模板占位符高亮说明」与这里保持一致）：
 *  * `{{context}}` 最近对话，格式 `[时间] 昵称：内容`，非 text 已由适配器替换为占位描述；
 *  * `{{question}}` 触发消息（本次要回复的那条）；
 *  * `{{sender}}` 触发者昵称；
 *  * `{{target}}` 目标会话名（群名 / 对方昵称）；
 *  * 未识别的 `{{xxx}}` **原样保留**：宁可让模型看到占位符，也不要静默吞掉
 *    用户的模板意图（UI 保存时会警告变量缺失）。
 */
import type { WelinkConversation, WelinkMessage } from '@/types/welink'

export interface PromptInput {
  template: string
  target: WelinkConversation | null
  /** 最近对话（时间正序） */
  context: WelinkMessage[]
  /** 触发消息 */
  trigger: WelinkMessage | null
  /** 目标会话名兜底（会话已被删除时） */
  targetFallback?: string
}

/** 单条消息渲染成上下文行：`[09-27 14:03] 李明：内容` */
export function formatContextLine(message: WelinkMessage): string {
  const clock = message.sentAt.slice(5, 16).replace('T', ' ')
  const who = message.direction === 'out' ? '我' : message.senderName || message.senderId || '对方'
  return `[${clock}] ${who}：${message.content}`
}

/** 渲染完整提示词（纯函数，便于单测逐项断言） */
export function renderPrompt(input: PromptInput): string {
  const context = input.context.length
    ? input.context.map(formatContextLine).join('\n')
    : '（暂无历史消息）'
  const question = input.trigger
    ? input.trigger.content
    : '（未取到触发消息，请基于最近对话给出回应）'
  const sender = input.trigger?.senderName || input.trigger?.senderId || '对方'
  const target = input.target?.remark
    ? `${input.target.title}（${input.target.remark}）`
    : input.target?.title || input.targetFallback || input.trigger?.convId || '未知会话'

  return input.template
    .replaceAll('{{context}}', context)
    .replaceAll('{{question}}', question)
    .replaceAll('{{sender}}', sender)
    .replaceAll('{{target}}', target)
}

/** 模板里缺失的变量（UI 保存时警告 + 单测断言用） */
export function missingPlaceholders(template: string): string[] {
  const required = ['{{context}}', '{{question}}']
  return required.filter((token) => !template.includes(token))
}

/** 模板里出现的未知变量（保留原样但提示用户） */
export function unknownPlaceholders(template: string): string[] {
  const known = new Set(['{{context}}', '{{question}}', '{{sender}}', '{{target}}'])
  const found = template.match(/\{\{[a-zA-Z_]+\}\}/g) ?? []
  return [...new Set(found.filter((token) => !known.has(token)))]
}

/**
 * 清理模型返回的正文。
 *
 * 模型常带包裹痕迹（三引号代码块、整体双引号、`回复：` 前缀、多个空行）——
 * 这些如果原样发出去，群里看到的就是「```」而不是一句话。清理是**保守**的：
 * 只去掉明确是包裹物的东西，不改动正文内容本身。
 */
export function sanitizeReply(raw: string): string {
  let text = raw.trim()
  // ``` 代码块包裹
  const fenced = /^```[a-zA-Z]*\n([\s\S]*?)\n?```$/.exec(text)
  if (fenced) text = fenced[1].trim()
  // 常见前缀
  text = text.replace(/^(回复|答复|回答|Reply)\s*[:：]\s*/i, '')
  // 整体被引号包裹
  if (
    (text.startsWith('"') && text.endsWith('"')) ||
    (text.startsWith('“') && text.endsWith('”')) ||
    (text.startsWith('「') && text.endsWith('」'))
  ) {
    text = text.slice(1, -1).trim()
  }
  // 连续空行压成单个换行（群消息里连续空行很突兀）
  text = text.replace(/\n{2,}/g, '\n')
  return text.trim()
}