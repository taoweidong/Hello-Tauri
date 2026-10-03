import { beforeEach, describe, expect, it, vi } from 'vitest'

import { DEFAULT_CODEHUB_SETTINGS, type CodeHubSettings } from '@/types/codehub'

/**
 * CodeHub 端口工厂测试（welink 工厂同款套路）：平台切换 / 强制 mock / 空路径回退 /
 * 缓存键重建 —— 「换真实接口不需要动编排层」承诺的守卫。
 */

const { state, createCliCodeHubPort, createMockCodeHubPort } = vi.hoisted(() => ({
  state: { platform: 'tauri' as 'tauri' | 'web' },
  createCliCodeHubPort: vi.fn(() => ({ impl: 'cli' })),
  // mock 实例带注入方法签名：mockHandle() 靠这两个方法识别 mock
  createMockCodeHubPort: vi.fn(() => ({ impl: 'mock', injectTransportFailure: vi.fn(), injectParseFailure: vi.fn() })),
}))

vi.mock('@/api', () => ({
  get platform() {
    return state.platform
  },
}))
vi.mock('./codehub-cli', () => ({
  createCliCodeHubPort: (...args: unknown[]) => createCliCodeHubPort(...(args as [])),
}))
vi.mock('./mock', () => ({ createMockCodeHubPort: (...args: unknown[]) => createMockCodeHubPort(...(args as [])) }))
vi.mock('@/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

function settings(overrides: Partial<CodeHubSettings> = {}): CodeHubSettings {
  return { ...DEFAULT_CODEHUB_SETTINGS, source: 'cli', cliPath: 'C:\\tools\\codehub-cli.exe', token: 't', ...overrides }
}

async function freshFactory() {
  vi.resetModules()
  return import('./index')
}

describe('codehub 端口工厂', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    state.platform = 'tauri'
  })

  it('桌面 + cli + 有效路径：走真实 CLI 适配器（路径裁剪、token 透传）', async () => {
    const factory = await freshFactory()
    factory.codeHubPort({ settings: settings({ cliPath: '  C:\\tools\\codehub-cli.exe  ' }) })
    expect(createCliCodeHubPort).toHaveBeenCalledWith({
      cliPath: 'C:\\tools\\codehub-cli.exe',
      token: 't',
      timeoutMs: 12_000,
    })
    expect(createMockCodeHubPort).not.toHaveBeenCalled()
  })

  it('浏览器模式强制 mock（即使配置了 cli），mock 参数透传', async () => {
    state.platform = 'web'
    const factory = await freshFactory()
    const mockOptions = { transportFailures: 1 }
    factory.codeHubPort({ settings: settings(), mock: mockOptions })
    expect(factory.mockHandle()).not.toBeNull()
    expect(createMockCodeHubPort).toHaveBeenCalledWith(mockOptions)
    expect(createCliCodeHubPort).not.toHaveBeenCalled()
  })

  it('选 cli 但路径为空：回退 mock 并告警（不让每次同步都报错）', async () => {
    const factory = await freshFactory()
    factory.codeHubPort({ settings: settings({ cliPath: '   ' }) })
    expect(factory.mockHandle()).not.toBeNull()
    expect(createCliCodeHubPort).not.toHaveBeenCalled()
  })

  it('缓存键命中：同配置复用实例；token/来源变化立即重建（改完设置即生效）', async () => {
    const factory = await freshFactory()
    const first = factory.codeHubPort({ settings: settings() })
    const second = factory.codeHubPort({ settings: settings() })
    expect(second).toBe(first)
    expect(createCliCodeHubPort).toHaveBeenCalledTimes(1)

    factory.codeHubPort({ settings: settings({ token: 't2' }) })
    expect(createCliCodeHubPort).toHaveBeenCalledTimes(2)

    factory.codeHubPort({ settings: settings({ source: 'mock' }) })
    expect(createMockCodeHubPort).toHaveBeenCalledTimes(1)

    factory.resetCodeHubPort()
    factory.codeHubPort({ settings: settings() })
    expect(createCliCodeHubPort).toHaveBeenCalledTimes(3)
  })

  it('isMockCodeHub / mockHandle：mock 实例可识别，cli 实例返回 null', async () => {
    const factory = await freshFactory()
    factory.codeHubPort({ settings: settings({ source: 'mock' }) })
    expect(factory.isMockCodeHub()).toBe(true)
    expect(factory.mockHandle()).not.toBeNull()
    factory.resetCodeHubPort()
    factory.codeHubPort({ settings: settings() })
    expect(factory.isMockCodeHub()).toBe(false)
    expect(factory.mockHandle()).toBeNull()
  })
})
