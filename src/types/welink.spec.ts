import { describe, expect, it } from 'vitest'

/**
 * 大模型连接配置归一化（`WelinkAgentSettings` 新增的 apiStyle / apiKey / model）。
 *
 * config.json 是用户可手改的 JSON：越界值、错类型、缺字段都必须在入口收敛，
 * 否则运行期拿到 undefined 直接炸在管线深处。这里钉住三层兜底：
 * 老配置缺字段 → 默认值；非法枚举 → 收敛到合法值；错类型 → 空串兜底。
 */
import { DEFAULT_WELINK_SETTINGS, normalizeWelinkSettings, type WelinkSettings } from './welink'

/** normalize 的入参声明是浅 Partial（嵌套 agent 要求完整对象），构造手改 JSON 形状的输入需窄化 */
function normalizeAgent(agent: Record<string, unknown>) {
  return normalizeWelinkSettings({ agent } as unknown as Partial<WelinkSettings>).agent
}

describe('types/welink —— 大模型连接配置归一化', () => {
  it('老配置缺新字段时回退默认（apiStyle=simple、apiKey/model 空串）', () => {
    const merged = normalizeAgent({
      agentSource: 'http',
      baseUrl: 'http://127.0.0.1:8080',
      endpoint: '/chat',
      timeoutMs: 60_000,
      maxContextMsgs: 20,
      promptTemplate: 'T',
    })
    expect(merged.apiStyle).toBe('simple')
    expect(merged.apiKey).toBe('')
    expect(merged.model).toBe('')
  })

  it('apiStyle 非法值收敛为 simple（openai 是唯一合法的非默认值）', () => {
    expect(normalizeAgent({ apiStyle: 'openai' }).apiStyle).toBe('openai')
    expect(normalizeAgent({ apiStyle: 'anthropic' }).apiStyle).toBe('simple')
  })

  it('apiKey / model 保留内容并去除首尾空白', () => {
    const merged = normalizeAgent({ apiKey: '  sk-abc  ', model: ' Qwen2.5-7B-Instruct ' })
    expect(merged.apiKey).toBe('sk-abc')
    expect(merged.model).toBe('Qwen2.5-7B-Instruct')
  })

  it('非字符串类型兜底为空串（手改 JSON 写错类型不炸）', () => {
    const merged = normalizeAgent({ apiKey: 123, model: null })
    expect(merged.apiKey).toBe('')
    expect(merged.model).toBe('')
  })

  it('出厂默认配置自带新字段（首次启动落盘即完整）', () => {
    expect(DEFAULT_WELINK_SETTINGS.agent).toMatchObject({ apiStyle: 'simple', apiKey: '', model: '' })
  })
})
