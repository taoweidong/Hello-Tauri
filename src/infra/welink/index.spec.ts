import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { WelinkSettings } from '@/types/welink'

/**
 * 端口工厂测试（quality-hardening-2026-10 5.2）：平台切换 / 强制 mock / 空路径
 * 回退 / 缓存键重建 / 演示剧本 —— 「换真实接口不需要动编排层」承诺的守卫。
 */

const { state, createCliWelinkPort, createMockWelinkPort, createCliGroupPort, createMockGroupPort } = vi.hoisted(() => {
  const mkMock = () => ({ playScript: vi.fn(), reset: vi.fn(), mockMark: true })
  return {
    state: { platform: 'tauri' as 'tauri' | 'web' },
    createCliWelinkPort: vi.fn(() => ({ impl: 'cli' })),
    createMockWelinkPort: vi.fn(() => mkMock()),
    createCliGroupPort: vi.fn(() => ({ impl: 'group-cli' })),
    createMockGroupPort: vi.fn(() => ({ impl: 'group-mock' })),
  }
})

vi.mock('@/api', () => ({
  get platform() {
    return state.platform
  },
}))
vi.mock('./welink-cli', () => ({ createCliWelinkPort: (...args: unknown[]) => createCliWelinkPort(...(args as [])) }))
vi.mock('./group-cli', () => ({ createCliGroupPort: (...args: unknown[]) => createCliGroupPort(...(args as [])) }))
vi.mock('./mock', () => ({ createMockWelinkPort: (...args: unknown[]) => createMockWelinkPort(...(args as [])) }))
vi.mock('./group-mock', () => ({ createMockGroupPort: (...args: unknown[]) => createMockGroupPort(...(args as [])) }))
vi.mock('@/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

function settings(overrides: Partial<WelinkSettings> = {}): WelinkSettings {
  return {
    welinkSource: 'cli',
    cliPath: 'C:\\tools\\welink-cli.exe',
    myUserId: '10086',
    agent: { timeoutMs: 30_000, agentSource: 'http', baseUrl: 'http://127.0.0.1:8080' },
    ...overrides,
  } as WelinkSettings
}

async function freshFactory() {
  vi.resetModules()
  return import('./index')
}

describe('welink 端口工厂', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    state.platform = 'tauri'
  })

  it('桌面 + cli + 有效路径：走真实 CLI 适配器（路径裁剪 + 超时钳到 12s）', async () => {
    const factory = await freshFactory()
    const port = factory.welinkClient({ settings: settings({ agent: { timeoutMs: 30_000 } as never }) })
    expect(port).toEqual({ impl: 'cli' })
    expect(createCliWelinkPort).toHaveBeenCalledWith({
      cliPath: 'C:\\tools\\welink-cli.exe',
      myUserId: '10086',
      timeoutMs: 12_000,
    })
  })

  it('浏览器模式强制 mock（即使选了 cli 且路径有效，D5）', async () => {
    state.platform = 'web'
    const factory = await freshFactory()
    const port = factory.welinkClient({ settings: settings() })
    expect(createCliWelinkPort).not.toHaveBeenCalled()
    expect(createMockWelinkPort).toHaveBeenCalledTimes(1)
    expect(port).toHaveProperty('mockMark', true)
  })

  it('桌面选 cli 但路径为空：回退 mock + 告警（而不是每次轮询都报错）', async () => {
    const factory = await freshFactory()
    const port = factory.welinkClient({ settings: settings({ cliPath: '  ' }) })
    expect(createCliWelinkPort).not.toHaveBeenCalled()
    expect(port).toHaveProperty('mockMark', true)
    const { logger } = await import('@/utils/logger')
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('未配置路径'))
  })

  it('同配置命中缓存：不重建实例（O14 的「配置一改立即换实例」反面）', async () => {
    const factory = await freshFactory()
    const first = factory.welinkClient({ settings: settings() })
    const second = factory.welinkClient({ settings: settings() })
    expect(second).toBe(first)
    expect(createCliWelinkPort).toHaveBeenCalledTimes(1)
  })

  it('配置变更（cliPath）→ 缓存键变化 → 重建实例', async () => {
    const factory = await freshFactory()
    factory.welinkClient({ settings: settings({ cliPath: 'a.exe' }) })
    factory.welinkClient({ settings: settings({ cliPath: 'b.exe' }) })
    expect(createCliWelinkPort).toHaveBeenCalledTimes(2)
  })

  it('演示剧本模式：mock 端口装配后立即 playScript（O13）', async () => {
    const factory = await freshFactory()
    factory.welinkClient({ settings: settings({ welinkSource: 'mock' }), scripted: true })
    const handle = factory.mockHandle()
    expect(handle?.playScript).toHaveBeenCalledTimes(1)
  })

  it('mockHandle：cli 端口返回 null（演示按钮置灰依据）', async () => {
    const factory = await freshFactory()
    factory.welinkClient({ settings: settings() })
    expect(factory.mockHandle()).toBeNull()
  })

  it('resetWelinkClient 清缓存：同配置重建新实例', async () => {
    const factory = await freshFactory()
    const first = factory.welinkClient({ settings: settings() })
    factory.resetWelinkClient()
    const second = factory.welinkClient({ settings: settings() })
    expect(second).not.toBe(first)
  })

  it('isMockWelink 反映当前端口类型', async () => {
    const factory = await freshFactory()
    factory.welinkClient({ settings: settings({ welinkSource: 'mock' }) })
    expect(factory.isMockWelink()).toBe(true)
    factory.welinkClient({ settings: settings() })
    expect(factory.isMockWelink()).toBe(false)
  })
})

describe('建群端口工厂', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    state.platform = 'tauri'
  })

  it('桌面 + cli：走真实建群适配器', async () => {
    const factory = await freshFactory()
    const port = factory.groupClient({ settings: settings() })
    expect(port).toEqual({ impl: 'group-cli' })
    expect(createCliGroupPort).toHaveBeenCalledWith({ cliPath: 'C:\\tools\\welink-cli.exe' })
  })

  it('浏览器模式强制 mock；同源缓存命中不重建', async () => {
    state.platform = 'web'
    const factory = await freshFactory()
    const first = factory.groupClient({ settings: settings() })
    const second = factory.groupClient({ settings: settings() })
    expect(createMockGroupPort).toHaveBeenCalledTimes(1)
    expect(second).toBe(first)
  })

  it('桌面选 cli 但路径为空：回退 mock + 告警', async () => {
    const factory = await freshFactory()
    factory.groupClient({ settings: settings({ cliPath: '' }) })
    expect(createCliGroupPort).not.toHaveBeenCalled()
    const { logger } = await import('@/utils/logger')
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('建群回退'))
  })
})
