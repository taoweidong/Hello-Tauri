/**
 * 技能路由器（skill-routing 设计 §7，docs/design-welink-skill-routing-2026-10-04.md）。
 *
 * 在生成段的「拉上下文」与「渲染提示词」之间插入的一步：为每个回复任务从技能清单
 * 中选定**唯一**技能，按固定次序兜底（S-A）：
 *
 *   ① 规则命中（关键词包含 / `/…/` 正则，按配置顺序取首个命中者）
 *   ② LLM 分类兜底（受 `llmClassifyFallback` 开关控制，复用 Agent 端口）
 *   ③ 内置兜底技能（通用助手）
 *
 * 任何分支都不 reject、不重试、不阻断生成主链路 —— 分类只是「选哪套模板」，不是
 * 回复本身；失败细节已由 Agent 的 onCall 钩子落 `welink_agent_logs` 可回溯（S-H）。
 */
import type { AgentClient } from '@/infra/agent'
import { sanitizeUntrusted } from '@/infra/agent/prompt'
import type { SkillSource, WelinkMessage, WelinkSkill } from '@/types/welink'
import { FALLBACK_SKILL_ID } from '@/types/welink'
import { logger } from '@/utils/logger'

export interface SkillDecision {
  skill: WelinkSkill
  source: SkillSource
}

export interface RouteSkillInput {
  /** 触发消息内容（本次要回复的那条） */
  question: string
  /** 最近对话（时间正序；规则匹配与触发消息共同构成匹配作用域） */
  context: WelinkMessage[]
  /** 完整候选清单（含兜底技能；停用技能在内部统一跳过） */
  candidates: WelinkSkill[]
  /** 兜底技能（②未启用或失败时的归宿） */
  fallback: WelinkSkill
  /** 是否允许 LLM 分类兜底 */
  llmClassify: boolean
  agent: AgentClient
  /** 分类调用发起前回调（管线用它登记 agent 留痕的归属槽位，见 pipeline 的 promptOwners） */
  onClassifyPrompt?: (prompt: string) => void
}

/** 规则匹配作用域的上限：触发消息 + 最近上下文拼接过长时截断，防超长文本拖慢逐词条匹配 */
const MATCH_TEXT_MAX_CHARS = 2000

/**
 * `/…/` 形式的词条按正则解释（不区分大小写）；非法正则跳过并 warn，不抛 ——
 * 关键词是用户手填的，一个写坏的词条不应该拖垮整个技能路由。
 */
function parseRegexKeyword(keyword: string): RegExp | null {
  if (!(keyword.length > 2 && keyword.startsWith('/') && keyword.endsWith('/'))) return null
  try {
    return new RegExp(keyword.slice(1, -1), 'i')
  } catch (error: unknown) {
    logger.warn(`技能关键词非法正则已跳过：${keyword}（${String(error)}）`)
    return null
  }
}

/**
 * 规则匹配：按 skills 数组**配置顺序**取首个命中者（先配置先匹配，UI 可排序表达优先级）；
 * 匹配作用域 = 触发消息 + 最近上下文拼接文本；普通词条包含匹配（不区分大小写）。
 * 兜底技能（id='fallback'）不参与规则匹配 —— 它就是「没匹配上」的归宿（设计 §7）。
 */
export function matchSkillByRules(question: string, contextText: string, skills: WelinkSkill[]): WelinkSkill | null {
  const text = `${question}\n${contextText}`.slice(0, MATCH_TEXT_MAX_CHARS)
  const lowered = text.toLowerCase()
  for (const skill of skills) {
    if (!skill.enabled || skill.id === FALLBACK_SKILL_ID) continue
    for (const keyword of skill.keywords) {
      const trimmed = keyword.trim()
      if (!trimmed) continue
      const regex = parseRegexKeyword(trimmed)
      if (regex ? regex.test(text) : lowered.includes(trimmed.toLowerCase())) return skill
    }
  }
  return null
}

/**
 * 分类提示词：形状固定（可读、可留痕、可调优）—— 技能清单（id/名称/说明）+ 待分类消息。
 * 只要求模型输出技能 id；消息正文经不可信消毒（该 prompt 会整体落 agent_logs）。
 */
export function buildClassifyPrompt(candidates: WelinkSkill[], question: string): string {
  const list = candidates
    .filter((skill) => skill.enabled)
    .map((skill) => `- id: ${skill.id}  名称：${skill.name}  说明：${skill.description || '（未填写）'}`)
    .join('\n')
  return [
    '你是消息分类器。根据技能清单，为「需要回复的消息」选择唯一合适的技能。',
    '只输出该技能的 id，不要输出任何其他文字。',
    '',
    '可用技能：',
    list,
    '',
    '【需要回复的消息】',
    sanitizeUntrusted(question),
  ].join('\n')
}

/**
 * 严格解析分类回复：trim 后全等某候选 id → 否则取文本中**最早出现**的合法 id
 * （模型可能带「技能：xxx」之类前缀）；同位置命中多个 id 时取更长者
 * （'fallback-2' 是完整 id，不能被其前缀 'fallback' 抢走）。找不到 → null。
 */
export function parseClassifyReply(reply: string, candidates: WelinkSkill[]): string | null {
  const ids = candidates.filter((skill) => skill.enabled).map((skill) => skill.id)
  const text = reply.trim()
  if (!text) return null
  if (ids.includes(text)) return text
  let best: { id: string; at: number } | null = null
  for (const id of ids) {
    const at = text.indexOf(id)
    if (at < 0) continue
    if (!best || at < best.at || (at === best.at && id.length > best.id.length)) best = { id, at }
  }
  return best?.id ?? null
}

/** 技能路由唯一入口：规则 → LLM 兜底（可开关）→ fallback。永不 reject（S-A/S-H） */
export async function routeSkill(input: RouteSkillInput): Promise<SkillDecision> {
  const enabled = input.candidates.filter((skill) => skill.enabled)
  const byRule = matchSkillByRules(input.question, input.context.map((message) => message.content).join('\n'), enabled)
  if (byRule) return { skill: byRule, source: 'rule' }

  // LLM 兜底：清单里只剩兜底技能时分类没有意义（只有一个可选），直接省掉这次调用
  const hasUserSkills = enabled.some((skill) => skill.id !== FALLBACK_SKILL_ID)
  if (input.llmClassify && hasUserSkills) {
    const prompt = buildClassifyPrompt(enabled, input.question)
    input.onClassifyPrompt?.(prompt)
    try {
      const reply = await input.agent.complete(prompt)
      const id = parseClassifyReply(reply, enabled)
      const skill = id ? enabled.find((item) => item.id === id) : undefined
      if (skill) return { skill, source: 'llm' }
      logger.warn(`技能分类未解析出合法 id，走兜底：${reply.slice(0, 50)}`)
    } catch (error: unknown) {
      // 超时/报错都由 onCall 落 agent_logs；这里只降级，不重试 —— 分类不是回复本身
      logger.warn(`技能分类调用失败，走兜底：${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return { skill: input.fallback, source: 'fallback' }
}
