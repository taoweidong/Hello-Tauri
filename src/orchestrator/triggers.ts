/**
 * 触发规则（设计 §7.1）—— 编排层的业务判定，**不进数据层**。
 *
 * 为什么单独成文件：仓储只负责「有触发就建 job」（`ApplyRules.triggers` 由这里算好传入），
 * 这样规则变更只需要改这一处、也只在这一处被测试；仓储保持「哑」以便直接断言 SQL。
 *
 * 规则表（§7.1 逐条落地）：
 *
 * | 场景 | 存档 | 自动回复 |
 * |------|------|---------|
 * | 群消息 @我（text，群 watching=1） | ✅ | ✅ group_at_me |
 * | 群消息 未@我 | ✅ | ❌ |
 * | 私聊消息（text） | ✅ 双向 | ✅ private |
 * | 非 text 类型 | ✅ 占位描述 | ❌ |
 * | 自发消息（direction=out） | ✅ | ❌（senderId==myUserId 过滤，防循环） |
 *
 * 两个容易写错的地方（都有单测覆盖）：
 *  * **@所有人 不算 @我**（Q5）—— 判断依据是适配器归一化后的 `atMe`，
 *    适配器已在解析时排除 @所有人；这里再兜一道「@所有人」文本检测，
 *    因为真实 CLI 若把 atMe 置真，我们仍不能回复全员广播。
 *  * **建 job 与放行外发是两回事**（v4.2）：本文件只决定「是否建任务」，
 *    开关/频控拦截发生在 SafetyGate（外发前）。job 与消息照常留档可审计。
 */
import type { NormalizedMessage, TriggerType } from '@/types/welink'

/** 触发规则依赖的最小设置面（不引整个 WelinkSettings，便于测试构造） */
export interface TriggerSettings {
  /** 监控存档开关（watching=0 的会话不该产生任何任务） */
  watching: boolean
  /** 本人工号（用于过滤自发消息） */
  myUserId: string
  /**
   * L2 场景开关。**注意：这里不据此拒绝建任务** —— 关闭场景开关时仍要留档
   * 「本可以回复但场景关闭」，审计与改进（R3/R4）看得到每一次被拦。
   * 该参数仅用于 `explainSkip` 的文案推导。
   */
  groupAtMe: boolean
  privateAutoReply: boolean
  /**
   * S5 同人短窗合并窗口（秒）。
   *
   * 在这里（建任务时）合并，而不是只在 Gate 里拦：Gate 只看到「上一个 job 已经
   * 发出去了」，那时再合并已经晚了 —— 内容补不进已生成的提示词。在建任务阶段
   * 把同一发送者短窗内的多次触发收敛成**一个** job，管线随后拉取的
   * `recentContext` 天然包含全部消息，于是「一次回复、上下文含全部触发」成立。
   * 传 0 或负数表示不做合并（测试与「关闭合并」场景）。
   */
  mergeWindowSec: number
}

/**
 * 判定单条消息是否命中回复规则，返回触发类型；未命中返回 null。
 */
export function matchTrigger(message: NormalizedMessage, settings: TriggerSettings): TriggerType | null {
  // 会话未监控：不建任务（消息也不会被拉取，双保险）
  if (!settings.watching) return null
  // 自发消息：direction=out 或发送者就是本人 → 防自回复循环（§7.1 最后一行）
  if (message.direction === 'out') return null
  if (settings.myUserId && message.senderId === settings.myUserId) return null
  // 非 text 仅占位存档（图片/文件/系统消息无内容可回）
  if (message.msgType !== 'text') return null

  if (message.convType === 'private') return 'private'

  // 群消息：必须 @我，且不能是 @所有人
  if (!message.atMe) return null
  if (isAtAll(message.content)) return null
  return 'group_at_me'
}

/**
 * @所有人 文本检测（Q5 的兜底）。
 *
 * 适配器解析时已经排除了 @所有人，这里再判一次是因为：真实 CLI 的 `atMe`
 * 字段语义尚未定型（Q1 开放项），若它把 @所有人 也算 atMe，我们会误回全员广播 ——
 * 这类错误的代价（群里刷屏）远大于多一次字符串检测的成本。
 */
export function isAtAll(content: string): boolean {
  // 注意：这里**不能用 `\b`**。`\b` 只在 `\w`（[A-Za-z0-9_]）与非 `\w` 之间成立，
  // 而汉字不属于 `\w` —— `/@\s*(所有人|全体成员|all)\b/` 对「@所有人」会返回 false，
  // 兜底检测形同虚设（单测抓到的真实缺陷，见 triggers.spec.ts）。
  // 改用**否定前瞻**排除「以字母数字开头的更长单词」（@allin / @allegation 不算），
  // 对 CJK 与行尾同样成立。
  return /@\s*(所有人|全体成员|all)(?![A-Za-z0-9_])/i.test(content)
}

/**
 * 同人短窗合并（S5）—— 一轮拉取内**只保留最早的一条**作为触发。
 *
 * 语义是「合并为一次回复」而不是「丢弃后来的」：被合并掉的消息**照常入库**
 * （消息一条不丢，`triggers` 只决定建不建任务）；管线生成提示词时按
 * `recentContext` 拉取该会话最近 N 条，短窗内的后续消息自然落在上下文里，
 * 模型能一次看到全部触发，用户只收到一条回复 —— 正是设计 §5A.2-S5
 * 「防刷屏式连发」想要的效果。
 *
 * 为什么以「发送者」而非「会话」为合并维度：同一个人连发三条要合并，
 * 但群里的三个人几乎同时 @我 是三个不同的人，各自需要被回复。
 *
 * `mergeWindowSec <= 0` 时不做任何合并（测试与「关闭该规则」的场景）。
 */
export function mergeBySenderWindow(
  messages: NormalizedMessage[],
  triggers: Record<string, TriggerType>,
  mergeWindowSec: number,
): { triggers: Record<string, TriggerType>; merged: string[] } {
  if (mergeWindowSec <= 0) return { triggers, merged: [] }

  const windowMs = mergeWindowSec * 1000
  const kept: Record<string, TriggerType> = {}
  const merged: string[] = []
  /** 会话 → 发送者 → 本次轮询内已保留的那条消息的时间 */
  const seen = new Map<string, Map<string, number>>()

  // 按时间升序处理，保证「最早的一条」被保留，不受输入数组顺序影响
  const ordered = [...messages].sort((a, b) =>
    a.sentAt === b.sentAt ? a.msgUid.localeCompare(b.msgUid) : a.sentAt < b.sentAt ? -1 : 1,
  )
  for (const message of ordered) {
    const trigger = triggers[message.msgUid]
    if (!trigger) continue
    const at = parseSentAt(message.sentAt)
    if (at === null) {
      kept[message.msgUid] = trigger
      continue
    }
    const perConv = seen.get(message.convId) ?? new Map<string, number>()
    seen.set(message.convId, perConv)
    const previous = perConv.get(message.senderId)
    if (previous !== undefined && at - previous < windowMs) {
      merged.push(message.msgUid)
      continue
    }
    perConv.set(message.senderId, at)
    kept[message.msgUid] = trigger
  }
  return { triggers: kept, merged }
}

/** 解析消息时间（`YYYY-MM-DD HH:mm:ss`）；无法解析返回 null（不参与合并判定） */
function parseSentAt(value: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(value.trim())
  if (!match) return null
  const [, y, mo, d, h, mi, s] = match
  return new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s)).getTime()
}

/**
 * 批量计算一轮拉取的触发表（`ApplyRules.triggers` 的形状：msgUid → 触发类型）。
 *
 * 顺带返回未触发原因统计，供日志与「立即拉取」的汇总文案使用 ——
 * 用户在群里发了条消息却没等到回复时，能从这里看到「为什么没建任务」。
 */
export function buildTriggerMap(
  messages: NormalizedMessage[],
  settings: TriggerSettings,
): { triggers: Record<string, TriggerType>; skipped: Record<string, string>; merged: string[] } {
  const triggers: Record<string, TriggerType> = {}
  const skipped: Record<string, string> = {}
  for (const message of messages) {
    const reason = matchSkipReason(message, settings)
    if (reason) {
      skipped[message.msgUid] = reason
      continue
    }
    triggers[message.msgUid] = message.convType === 'private' ? 'private' : 'group_at_me'
  }
  const { triggers: merged, merged: mergedUids } = mergeBySenderWindow(messages, triggers, settings.mergeWindowSec)
  for (const uid of mergedUids) skipped[uid] = '同一发送者短窗内已建任务（合并为一次回复）'
  return { triggers: merged, skipped, merged: mergedUids }
}

/** 未命中的原因文案（写成函数而不是注释，便于 UI 直接展示） */
export function matchSkipReason(message: NormalizedMessage, settings: TriggerSettings): string | null {
  if (!settings.watching) return '会话未开启监控'
  if (message.direction === 'out') return '自己发出的消息'
  if (settings.myUserId && message.senderId === settings.myUserId) return '自己发出的消息'
  if (message.msgType !== 'text') return `非文本消息（${message.msgType}）仅占位存档`
  if (message.convType === 'private') return null
  if (isAtAll(message.content)) return '@所有人 不算 @我'
  if (!message.atMe) return '群消息未 @我'
  return null
}

/**
 * 场景是否允许外发（L2，仅用于 UI 提示与说明；实际拦截在 SafetyGate）。
 */
export function sceneEnabled(message: NormalizedMessage, settings: TriggerSettings): boolean {
  return message.convType === 'private' ? settings.privateAutoReply : settings.groupAtMe
}
