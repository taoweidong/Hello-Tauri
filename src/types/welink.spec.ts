import { describe, expect, it } from 'vitest'

/**
 * 大模型连接配置归一化（`WelinkAgentSettings` 的 apiKey / model 等字段）。
 *
 * config.json 是用户可手改的 JSON：越界值、错类型、缺字段都必须在入口收敛，
 * 否则运行期拿到 undefined 直接炸在管线深处。这里钉住三层兜底：
 * 老配置缺字段 → 默认值；协议只有 OpenAI 兼容一种（apiStyle 维度已移除，
 * 老配置残留的该键会被 normalize 静默忽略）；错类型 → 空串兜底。
 */
import { DEFAULT_WELINK_SETTINGS, normalizeWelinkSettings, skillSourceLabelOf, type WelinkSettings } from './welink'

/** normalize 的入参声明是浅 Partial（嵌套 agent 要求完整对象），构造手改 JSON 形状的输入需窄化 */
function normalizeAgent(agent: Record<string, unknown>) {
  return normalizeWelinkSettings({ agent } as unknown as Partial<WelinkSettings>).agent
}

describe('types/welink —— 大模型连接配置归一化', () => {
  it('老配置缺字段时回退默认（apiKey/model 空串、endpoint 取 OpenAI 惯用路径）', () => {
    const merged = normalizeAgent({
      agentSource: 'http',
      baseUrl: 'http://127.0.0.1:11434',
      timeoutMs: 60_000,
      maxContextMsgs: 20,
      promptTemplate: 'T',
    })
    expect(merged.apiKey).toBe('')
    expect(merged.model).toBe('')
    expect(merged.endpoint).toBe(DEFAULT_WELINK_SETTINGS.agent.endpoint)
  })

  it('老配置残留的 apiStyle 键被忽略（协议已收敛为 OpenAI 兼容一种）', () => {
    const merged = normalizeAgent({ apiStyle: 'openai', apiKey: 'sk-1', model: 'm' })
    expect(merged).not.toHaveProperty('apiStyle')
    expect(merged.apiKey).toBe('sk-1')
    expect(merged.model).toBe('m')
  })

  it('apiKey / model 保留内容并去除首尾空白', () => {
    const merged = normalizeAgent({ apiKey: '  sk-abc  ', model: ' qwen3.8-flash ' })
    expect(merged.apiKey).toBe('sk-abc')
    expect(merged.model).toBe('qwen3.8-flash')
  })

  it('非字符串类型兜底为空串（手改 JSON 写错类型不炸）', () => {
    const merged = normalizeAgent({ apiKey: 123, model: null })
    expect(merged.apiKey).toBe('')
    expect(merged.model).toBe('')
  })

  it('出厂默认配置即 OpenAI 兼容形状（本地 Ollama 惯用地址 + /v1/chat/completions）', () => {
    expect(DEFAULT_WELINK_SETTINGS.agent).toMatchObject({
      baseUrl: 'http://127.0.0.1:11434',
      endpoint: '/v1/chat/completions',
      apiKey: '',
      model: '',
    })
  })
})

describe('types/welink —— 回复技能归一化（skill-routing）', () => {
  it('老配置缺 skills 字段零迁移：空清单 + LLM 分类兜底默认开', () => {
    const merged = normalizeAgent({ agentSource: 'mock' })
    expect(merged.skills).toEqual([])
    expect(merged.llmClassifyFallback).toBe(true)
  })

  it('技能字段逐项清洗：id slug 化、keywords 去空去错型、reviewMode 收敛', () => {
    const merged = normalizeAgent({
      skills: [
        {
          id: 'Fault Fix',
          name: ' 故障咨询 ',
          description: ' desc ',
          enabled: false,
          keywords: [' 报错 ', '', 123],
          reviewMode: 'manual',
          knowledge: ' KB ',
        },
      ],
    })
    expect(merged.skills).toHaveLength(1)
    expect(merged.skills[0]).toMatchObject({
      id: 'fault-fix',
      name: '故障咨询',
      description: 'desc',
      enabled: false,
      keywords: ['报错'],
      reviewMode: 'manual',
      knowledge: 'KB',
    })
  })

  it('上限按有效条目计：超限截断到 20、无名条目丢弃不占配额、空 id 派生序号', () => {
    const many = Array.from({ length: 25 }, (_, i) => ({ name: `技能${i + 1}` }))
    const merged = normalizeAgent({ skills: [{ knowledge: '没有名字' }, ...many] })
    expect(merged.skills).toHaveLength(20)
    expect(merged.skills[0]).toMatchObject({ id: 'skill-1', name: '技能1' })
  })

  it('id 去重与保留字：重复 id 追加 -2，fallback 保留给内置兜底技能', () => {
    const merged = normalizeAgent({
      skills: [
        { id: 'dup', name: 'A' },
        { id: 'dup', name: 'B' },
        { id: 'Fallback', name: 'C' },
      ],
    })
    expect(merged.skills.map((skill) => skill.id)).toEqual(['dup', 'dup-2', 'fallback-2'])
  })

  it('llmClassifyFallback 显式 false 保留，错类型收敛为 true', () => {
    expect(normalizeAgent({ llmClassifyFallback: false }).llmClassifyFallback).toBe(false)
    expect(normalizeAgent({ llmClassifyFallback: 'yes' }).llmClassifyFallback).toBe(true)
  })

  it('非数组 skills 回空清单（手改 JSON 写错类型不炸）', () => {
    expect(normalizeAgent({ skills: 'all' }).skills).toEqual([])
  })

  it('技能来源说明覆盖三种来源，老数据空串返回空（徽标 tooltip 不渲染依据）', () => {
    expect(skillSourceLabelOf('rule')).toBe('规则命中')
    expect(skillSourceLabelOf('llm')).toBe('模型分类')
    expect(skillSourceLabelOf('fallback')).toBe('兜底技能')
    expect(skillSourceLabelOf('')).toBe('')
  })
})
