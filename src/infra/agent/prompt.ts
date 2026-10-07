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
 *  * `{{knowledge}}` 技能知识块（skill-routing）：用户自配的**可信**文本，不经消毒、
 *    永不作为回复正文外发；空知识块替换为空串；
 *  * `{{retrieved}}` 检索事实占位符（rag-retrieval）：生成前按技能检索知识库的
 *    命中片段，由 pipeline 拼装（`【知识N】(来源, 相关度)` 头 + 正文）；可信文本
 *    不消毒；空命中替换为空串；
 *  * `{{docs}}` 本地知识文档占位符（knowledge-sedimentation K-F）：技能绑定的
 *    knowledge/*.md 文档内容，由 pipeline 拼装（`【文档·标题】` 头 + 正文）；
 *    经评审的可信文本不消毒；未绑定/读失败替换为空串；
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
  /** 技能知识块（可信文本，不消毒；skill-routing） */
  knowledge?: string
  /** RAG 检索命中片段（pipeline 拼装好的文本，可信不消毒；rag-retrieval） */
  retrieved?: string
  /** 本地知识文档内容（pipeline 拼装好的文本，经评审可信不消毒；knowledge-sedimentation） */
  docs?: string
}

/**
 * 单条不可信文本进入提示词前的最大长度。
 *
 * 为什么是常量而不是配置：这是防注入的**结构**约束，不是可调偏好 —— 用户把它
 * 调大等于关掉这道闸。400 字远大于正常聊天单条，足够模型理解语义。
 */
export const MAX_UNTRUSTED_CHARS = 400

/**
 * 不可信文本消毒（质量评审 P1：消息正文原样进 prompt，可伪造对话行/指令结构）。
 *
 * 三道处理，全部保守 —— 只降风险、不改正文语义：
 *  1. 剥控制字符（保留换行/制表）：提示词里的行结构只能由本端生成；
 *  2. 拍平换行：`[时间] 昵称：` 行格式无法被正文伪造出独立成行的假上下文；
 *  3. 超长截断并留痕：截断标记对模型可见，不是静默丢弃。
 *
 * 注意 `{{xxx}}` 占位符注入已由 renderPrompt 的单遍替换根治：替换值不会被
 * 再次扫描，正文里写 `{{target}}` 只是普通文本（有单测钉住）。
 */
export function sanitizeUntrusted(text: string, maxChars: number = MAX_UNTRUSTED_CHARS): string {
  // C0 控制字符 + DEL，保留 \n（\t）由下一步拍平
  // eslint-disable-next-line no-control-regex -- 剥控制字符正是本函数的功能（与 scripts 里 stripAnsi 的豁免同理）
  let out = text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
  out = out.replace(/\s*\n+\s*/g, ' ').trim()
  if (out.length > maxChars) out = `${out.slice(0, maxChars)}…[消息过长已截断]`
  return out
}

/** 单条消息渲染成上下文行：`[09-27 14:03] 李明：内容`（正文经不可信消毒） */
export function formatContextLine(message: WelinkMessage): string {
  const clock = message.sentAt.slice(5, 16).replace('T', ' ')
  const who = message.direction === 'out' ? '我' : message.senderName || message.senderId || '对方'
  return `[${clock}] ${who}：${sanitizeUntrusted(message.content)}`
}

/** 渲染完整提示词（纯函数，便于单测逐项断言） */
export function renderPrompt(input: PromptInput): string {
  const context = input.context.length ? input.context.map(formatContextLine).join('\n') : '（暂无历史消息）'
  // 触发消息同样经不可信消毒：它是注入收益最高的位置（模型被告知「要回复这条」）
  const question = input.trigger
    ? sanitizeUntrusted(input.trigger.content)
    : '（未取到触发消息，请基于最近对话给出回应）'
  const sender = input.trigger?.senderName || input.trigger?.senderId || '对方'
  const target = input.target?.remark
    ? `${input.target.title}（${input.target.remark}）`
    : input.target?.title || input.targetFallback || input.trigger?.convId || '未知会话'

  // **单遍**替换（有单测钉住）：不能用链式 replaceAll —— 链式时先替换进来的
  // 值会被后面的替换再次扫描，消息正文里写一句 {{target}} 就能注入占位符
  // （prompt.spec 的这条用例当初就是红的，抓到了这个真实漏洞）。
  const values: Record<string, string> = {
    context,
    question,
    sender,
    target,
    // 知识块、检索片段与本地文档都是用户侧可信文本（S-I/D8、D-I、K-F）：
    // 不消毒，也不进回复正文
    knowledge: input.knowledge ?? '',
    retrieved: input.retrieved ?? '',
    docs: input.docs ?? '',
  }
  return input.template.replace(
    /\{\{(context|question|sender|target|knowledge|retrieved|docs)\}\}/g,
    (_match, key: string) => values[key],
  )
}

/** 模板里缺失的变量（UI 保存时警告 + 单测断言用） */
export function missingPlaceholders(template: string): string[] {
  const required = ['{{context}}', '{{question}}']
  return required.filter((token) => !template.includes(token))
}

/** 模板里出现的未知变量（保留原样但提示用户） */
export function unknownPlaceholders(template: string): string[] {
  const known = new Set(['{{context}}', '{{question}}', '{{sender}}', '{{target}}', '{{knowledge}}', '{{retrieved}}', '{{docs}}'])
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
