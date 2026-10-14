import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { WelinkRagSettings } from '@/types/welink'

/**
 * RAG 工厂契约（第二轮补缺口，N1）。
 *
 * 与 `infra/agent/index.spec.ts` 同构：钉的是「上层拿到的实现是否与用户配置一致」
 * （浏览器强制 mock / 空 baseUrl 回退并 warn / 模块级缓存命中与失效）以及
 * `probeRag` 的三条分支（地址未填给可行动错误 · 桌面走真实探测 · 其余给演示结果）。
 *
 * 本文件此前只有 43% lines / 33% funcs —— 桌面分支在测试环境恒不可达，
 * 等于「用户在设置页点了『测试检索』之后到底发没发真实请求」从未被断言过。
 */

const fakes = vi.hoisted(() => {
  return {
    state: { platform: 'tauri' as 'tauri' | 'web' },
    createHttpRag: vi.fn((options: Record<string, unknown>) => ({ impl: 'http', options })),
    probeRagOnce: vi.fn(async (options: Record<string, unknown>) => ({
      latencyMs: 12,
      preview: `[0.9] 真实命中 · ${String(options.baseUrl)}`,
    })),
    createMockRag: vi.fn(() => ({ impl: 'mock', failNext: vi.fn() })),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  }
})

vi.mock('@/api', () => ({
  get platform() {
    return fakes.state.platform
  },
  bridge: { httpPostJson: vi.fn() },
}))
vi.mock('./rag-http', () => ({
  createHttpRag: (options: Record<string, unknown>) => fakes.createHttpRag(options),
  probeRagOnce: (options: Record<string, unknown>) => fakes.probeRagOnce(options),
}))
vi.mock('./mock', () => ({
  createMockRag: () => fakes.createMockRag(),
}))
vi.mock('@/utils/logger', () => ({ logger: fakes.logger }))

const SECRET = 'sk-rag-7d21e9a4c6'

function settings(overrides: Partial<WelinkRagSettings> = {}): WelinkRagSettings {
  return {
    ragSource: 'http',
    baseUrl: 'http://rag.intranet.local',
    endpoint: '/search',
    apiKey: SECRET,
    timeoutMs: 5_000,
    topK: 4,
    minScore: 0.3,
    maxChars: 1200,
    ...overrides,
  } as WelinkRagSettings
}

async function freshFactory() {
  vi.resetModules()
  return import('./index')
}

describe('infra/rag —— 端口工厂（平台兜底 / 缓存 / 探测）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    fakes.state.platform = 'tauri'
  })

  it('桌面 + http + 有效 baseUrl：走 HTTP 实现并透传 topK', async () => {
    const factory = await freshFactory()
    const client = factory.ragClient({ settings: settings() })
    expect(client).toMatchObject({ impl: 'http' })
    expect(fakes.createHttpRag).toHaveBeenCalledTimes(1)
    expect(fakes.createHttpRag.mock.calls[0][0]).toMatchObject({
      baseUrl: 'http://rag.intranet.local',
      endpoint: '/search',
      topK: 4,
      timeoutMs: 5_000,
    })
  })

  it('桌面模式注入宿主通道（检索 query 含对话原文，走 Rust 通道规避 CORS 与 2MB 截断）', async () => {
    const factory = await freshFactory()
    factory.ragClient({ settings: settings() })
    const options = fakes.createHttpRag.mock.calls[0][0] as { transport?: unknown }
    expect(typeof options.transport).toBe('function')
  })

  it('浏览器模式强制 mock（检索服务不可达），ragSource=http 也不外发', async () => {
    fakes.state.platform = 'web'
    const factory = await freshFactory()
    expect(factory.ragClient({ settings: settings() })).toMatchObject({ impl: 'mock' })
    expect(fakes.createHttpRag).not.toHaveBeenCalled()
  })

  it('选了 http 但 baseUrl 只有空白：回退 mock 并 warn', async () => {
    const factory = await freshFactory()
    expect(factory.ragClient({ settings: settings({ baseUrl: '  ' }) })).toMatchObject({ impl: 'mock' })
    expect(fakes.logger.warn).toHaveBeenCalledWith(expect.stringContaining('回退模拟数据源'))
  })

  it('ragSource=mock 时不 warn（本来就是模拟）', async () => {
    const factory = await freshFactory()
    factory.ragClient({ settings: settings({ ragSource: 'mock' }) })
    expect(fakes.logger.warn).not.toHaveBeenCalled()
  })

  it('相同配置命中缓存；topK 变更即重建', async () => {
    const factory = await freshFactory()
    const first = factory.ragClient({ settings: settings() })
    expect(factory.ragClient({ settings: settings() })).toBe(first)
    expect(factory.ragClient({ settings: settings({ topK: 8 }) })).not.toBe(first)
    expect(fakes.createHttpRag).toHaveBeenCalledTimes(2)
  })

  it('仅改 apiKey 也重建（缓存键含密钥）', async () => {
    const factory = await freshFactory()
    const first = factory.ragClient({ settings: settings() })
    expect(factory.ragClient({ settings: settings({ apiKey: 'sk-rag-other-0002' }) })).not.toBe(first)
  })

  it('resetRagClient() 清空缓存', async () => {
    const factory = await freshFactory()
    factory.ragClient({ settings: settings() })
    factory.resetRagClient()
    factory.ragClient({ settings: settings() })
    expect(fakes.createHttpRag).toHaveBeenCalledTimes(2)
  })

  it('工厂日志只打地址与 topK，绝不出现 apiKey', async () => {
    const factory = await freshFactory()
    factory.ragClient({ settings: settings() })
    const lines = [...fakes.logger.info.mock.calls, ...fakes.logger.warn.mock.calls].map((call) =>
      JSON.stringify(call),
    )
    expect(lines.join('\n')).not.toContain(SECRET)
  })

  it('isMockRag：mock 为 true / http 为 false / 未装配为 false', async () => {
    const factory = await freshFactory()
    expect(factory.isMockRag()).toBe(false)
    factory.ragClient({ settings: settings() })
    expect(factory.isMockRag()).toBe(false)
    factory.resetRagClient()
    factory.ragClient({ settings: settings({ ragSource: 'mock' }) })
    expect(factory.isMockRag()).toBe(true)
  })

  it('createRagProbe 不进缓存：探测不复用运行期实例', async () => {
    const factory = await freshFactory()
    const cached = factory.ragClient({ settings: settings() })
    const probe = factory.createRagProbe(settings())
    expect(probe).not.toBe(cached)
    // 且探测不写缓存：运行期实例仍是刚才那个
    expect(factory.ragClient({ settings: settings() })).toBe(cached)
  })

  it('createRagProbe 在浏览器模式给 mock', async () => {
    fakes.state.platform = 'web'
    const factory = await freshFactory()
    expect(factory.createRagProbe(settings())).toMatchObject({ impl: 'mock' })
  })
})

describe('infra/rag —— probeRag（设置页「测试检索」按钮）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    fakes.state.platform = 'tauri'
  })

  it('选了检索服务却没填地址：给可行动错误，而不是回退 mock 报「成功」误导配置者', async () => {
    const factory = await freshFactory()
    await expect(factory.probeRag(settings({ baseUrl: '   ' }))).rejects.toMatchObject({ kind: 'transport' })
    await expect(factory.probeRag(settings({ baseUrl: '' }))).rejects.toThrow(/未填写服务地址/)
    expect(fakes.probeRagOnce).not.toHaveBeenCalled()
  })

  it('桌面 + http + 有效地址：走真实探测，且超时被钳到 15s（探测不该等满推理时长）', async () => {
    const factory = await freshFactory()
    const result = await factory.probeRag(settings({ timeoutMs: 120_000 }))
    expect(result.preview).toContain('真实命中')
    expect(fakes.probeRagOnce).toHaveBeenCalledTimes(1)
    expect(fakes.probeRagOnce.mock.calls[0][0]).toMatchObject({ timeoutMs: 15_000 })
  })

  it('浏览器模式即使配置完整也给演示结果（真实通道不存在，不许假装探通）', async () => {
    fakes.state.platform = 'web'
    const factory = await freshFactory()
    const result = await factory.probeRag(settings())
    expect(result.latencyMs).toBe(0)
    expect(result.preview).toContain('模拟检索')
    expect(fakes.probeRagOnce).not.toHaveBeenCalled()
  })

  it('ragSource=mock 时给演示结果', async () => {
    const factory = await freshFactory()
    const result = await factory.probeRag(settings({ ragSource: 'mock' }))
    expect(result.preview).toContain('模拟检索')
    expect(fakes.probeRagOnce).not.toHaveBeenCalled()
  })
})
