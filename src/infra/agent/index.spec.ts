import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { WelinkAgentSettings } from '@/types/welink'

/**
 * Agent 工厂契约（第二轮补缺口，N1）。
 *
 * 为什么单开一个文件：`infra/agent/index.ts` 是「上层拿到的到底是不是用户配置
 * 指向的那个实现」的唯一判定点 —— 浏览器强制 mock、空 baseUrl 回退、模块级缓存
 * 命中/失效三条规则全在这里。它此前只有 50% lines / 40% funcs：
 * **http 分支在测试环境永远走不到**（platform 恒为 'web'），等于「真实用户桌面
 * 上跑的那条路从来没被测过」。这里用 `@/api` 的可变 platform 桩把它拉进来。
 *
 * 另外两个必须钉住的相邻面：
 *  * 缓存键里拼了 `apiKey` —— 换密钥必须换实例（否则改了密钥还在用旧连接）；
 *  * 密钥只进请求头不进日志 —— 工厂的 info/warn 是唯一会「顺手把配置打出来」的地方。
 */

const fakes = vi.hoisted(() => {
  return {
    state: { platform: 'tauri' as 'tauri' | 'web' },
    /** 每次调用返回**新对象**，便于断言「缓存命中 vs 重建」 */
    createHttpAgent: vi.fn((options: Record<string, unknown>) => ({ impl: 'http', options })),
    createMockAgent: vi.fn((options?: unknown) => ({ impl: 'mock', options, failNext: vi.fn() })),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  }
})

vi.mock('@/api', () => ({
  get platform() {
    return fakes.state.platform
  },
  bridge: { httpPostJson: vi.fn() },
}))
vi.mock('./agent-http', () => ({
  createHttpAgent: (options: Record<string, unknown>) => fakes.createHttpAgent(options),
}))
vi.mock('./mock', () => ({
  createMockAgent: (options?: unknown) => fakes.createMockAgent(options),
}))
vi.mock('@/utils/logger', () => ({ logger: fakes.logger }))

const SECRET = 'sk-agent-9f3c2b7a1d' // ≥4 位，够 registerSecret 的注册门槛长度级

function settings(overrides: Partial<WelinkAgentSettings> = {}): WelinkAgentSettings {
  return {
    agentSource: 'http',
    baseUrl: 'http://127.0.0.1:8080',
    endpoint: '/chat/completions',
    apiKey: SECRET,
    model: 'qwen-plus',
    timeoutMs: 30_000,
    maxContextMsgs: 8,
    promptTemplate: '',
    llmClassifyFallback: false,
    ...overrides,
  } as WelinkAgentSettings
}

async function freshFactory() {
  vi.resetModules()
  return import('./index')
}

describe('infra/agent —— 端口工厂（平台兜底 / 缓存 / 探测器）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    fakes.state.platform = 'tauri'
  })

  it('桌面 + http + 有效 baseUrl：走 HTTP 实现，且 baseUrl 已 trim', async () => {
    const factory = await freshFactory()
    const client = factory.agentClient({ settings: settings({ baseUrl: '  http://127.0.0.1:8080/  ' }) })
    expect(client).toMatchObject({ impl: 'http' })
    expect(fakes.createHttpAgent).toHaveBeenCalledTimes(1)
    expect(fakes.createHttpAgent.mock.calls[0][0]).toMatchObject({
      baseUrl: 'http://127.0.0.1:8080/',
      endpoint: '/chat/completions',
      model: 'qwen-plus',
      timeoutMs: 30_000,
    })
  })

  it('桌面模式把请求交给宿主通道（transport 已注入，规避大模型服务的 CORS 缺失）', async () => {
    const factory = await freshFactory()
    factory.agentClient({ settings: settings() })
    const options = fakes.createHttpAgent.mock.calls[0][0] as { transport?: unknown }
    expect(typeof options.transport).toBe('function')
  })

  it('浏览器模式强制 mock（无内网环境，fetch 必然失败），agentSource=http 也不外发', async () => {
    fakes.state.platform = 'web'
    const factory = await freshFactory()
    const client = factory.agentClient({ settings: settings() })
    expect(client).toMatchObject({ impl: 'mock' })
    expect(fakes.createHttpAgent).not.toHaveBeenCalled()
  })

  it('选了 http 但 baseUrl 只有空白：回退 mock 并 warn（不静默降级）', async () => {
    const factory = await freshFactory()
    const client = factory.agentClient({ settings: settings({ baseUrl: '   ' }) })
    expect(client).toMatchObject({ impl: 'mock' })
    expect(fakes.logger.warn).toHaveBeenCalledWith(expect.stringContaining('回退模拟数据源'))
  })

  it('agentSource=mock 时不 warn（本来就是模拟，不是降级）', async () => {
    const factory = await freshFactory()
    factory.agentClient({ settings: settings({ agentSource: 'mock' }) })
    expect(fakes.logger.warn).not.toHaveBeenCalled()
  })

  it('相同配置命中模块级缓存：第二次不再创建实例', async () => {
    const factory = await freshFactory()
    const first = factory.agentClient({ settings: settings() })
    const second = factory.agentClient({ settings: settings() })
    expect(second).toBe(first)
    expect(fakes.createHttpAgent).toHaveBeenCalledTimes(1)
  })

  it('配置变更重建实例：model 变了必须换（否则换模型不生效）', async () => {
    const factory = await freshFactory()
    const first = factory.agentClient({ settings: settings() })
    const second = factory.agentClient({ settings: settings({ model: 'qwen-max' }) })
    expect(second).not.toBe(first)
    expect(fakes.createHttpAgent).toHaveBeenCalledTimes(2)
  })

  it('配置变更重建实例：仅改 apiKey 也要换（缓存键含密钥，换密钥不能沿用旧连接）', async () => {
    const factory = await freshFactory()
    const first = factory.agentClient({ settings: settings() })
    const second = factory.agentClient({ settings: settings({ apiKey: 'sk-agent-another-0001' }) })
    expect(second).not.toBe(first)
    expect(fakes.createHttpAgent).toHaveBeenCalledTimes(2)
  })

  it('配置变更重建实例：超时变了也要换', async () => {
    const factory = await freshFactory()
    factory.agentClient({ settings: settings() })
    factory.agentClient({ settings: settings({ timeoutMs: 90_000 }) })
    expect(fakes.createHttpAgent).toHaveBeenCalledTimes(2)
  })

  it('resetAgentClient() 清空缓存（测试与「宿主环境变化」的出口）', async () => {
    const factory = await freshFactory()
    factory.agentClient({ settings: settings() })
    factory.resetAgentClient()
    factory.agentClient({ settings: settings() })
    expect(fakes.createHttpAgent).toHaveBeenCalledTimes(2)
  })

  it('工厂日志只打模型名，绝不出现 apiKey（密钥只进请求头）', async () => {
    const factory = await freshFactory()
    factory.agentClient({ settings: settings() })
    const lines = [...fakes.logger.info.mock.calls, ...fakes.logger.warn.mock.calls].map((call) =>
      JSON.stringify(call),
    )
    expect(lines.join('\n')).not.toContain(SECRET)
  })

  it('isMockAgent：mock 实现为 true / http 实现为 false / 尚未装配为 false', async () => {
    const factory = await freshFactory()
    expect(factory.isMockAgent()).toBe(false) // 缓存为空
    factory.agentClient({ settings: settings() })
    expect(factory.isMockAgent()).toBe(false) // http
    factory.resetAgentClient()
    factory.agentClient({ settings: settings({ agentSource: 'mock' }) })
    expect(factory.isMockAgent()).toBe(true)
  })

  it('createAgentProbe 不进缓存：探测请求不污染运行期实例（也不污染 R4 留痕）', async () => {
    const factory = await freshFactory()
    const probe = factory.createAgentProbe(settings())
    expect(probe).toMatchObject({ impl: 'http' })
    // 探测之后再取运行期客户端：必须是新实例（同一实现但两个对象），
    // 且运行期缓存此时才建立
    const runtimeClient = factory.agentClient({ settings: settings() })
    expect(runtimeClient).not.toBe(probe)
    expect(factory.isMockAgent()).toBe(false)

    // 反过来：先有运行期实例，探测仍要再建一个（不能被缓存吞掉）
    factory.resetAgentClient()
    const cached = factory.agentClient({ settings: settings() })
    const probe2 = factory.createAgentProbe(settings())
    expect(probe2).not.toBe(cached)
  })

  it('createAgentProbe 在浏览器模式给 mock（探测与运行链路对「当前实现」判定一致）', async () => {
    fakes.state.platform = 'web'
    const factory = await freshFactory()
    expect(factory.createAgentProbe(settings())).toMatchObject({ impl: 'mock' })
  })
})
