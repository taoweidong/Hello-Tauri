import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

import type { Updater, UpdateStatus } from '@/orchestrator/update'

/**
 * 自动更新 store 单测（第二轮补缺口，N2）。
 *
 * 为什么必须补：`stores/update.ts` 此前**整文件零覆盖**（0% lines），而它是唯一会
 * **自替换 exe** 的 UI 出口 —— 装配错一行，用户机器上的表现是「点了更新之后程序
 * 消失 / 回退 / 静默不动」，且没有日志可查。这里钉的是 store 自己的四件事：
 *
 *  1. 聚合口径（`hasUpdate` 关掉开关后必须恒假；`busy` 的状态集合）；
 *  2. 装配韧性（`init()` 装配失败只 warn 不抛；`update/state.json` 读回坏内容降级为 null）；
 *  3. U-J 铁律（apply 前先停 WeLink 与 CodeHub，且 **WeLink 运行中才停**）；
 *  4. 动作透传与版本注入（checkNow/install/scanInbox；currentVersion 取 appInfo）。
 *
 * 状态机、下载与验签语义在 `orchestrator/update.spec.ts`，这里不重复。
 */

/** Pinia setup store 会把 ref 解包：store 实例上直接是值，不是 .value */
interface UpdateStoreApi {
  status: UpdateStatus
  hasUpdate: boolean
  busy: boolean
  init(): void
  checkNow(): Promise<void>
  install(): Promise<void>
  scanInbox(): Promise<void>
}

const fakes = vi.hoisted(() => {
  const empty = (): UpdateStatus => ({
    state: 'idle',
    latest: null,
    progress: null,
    error: null,
    lastCheckAt: null,
    hintVersion: null,
  })
  const updater = {
    init: vi.fn(),
    getStatus: vi.fn(empty),
    onStatus: vi.fn((_handler: (status: UpdateStatus) => void) => vi.fn()),
    checkNow: vi.fn(async () => empty()),
    install: vi.fn(async () => undefined),
    scanInbox: vi.fn(async () => undefined),
    dispose: vi.fn(),
  }
  return {
    empty,
    updater,
    bridge: {
      notifySend: vi.fn(async () => undefined),
      fsRead: vi.fn(async () => ''),
      fsWrite: vi.fn(async () => undefined),
    },
    createUpdater: vi.fn((_deps: unknown) => updater),
    welink: { runtimeRunning: vi.fn(() => true), stop: vi.fn() },
    codehub: { stopAuto: vi.fn() },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    // 先给一份纯对象兜底：mock 工厂是懒执行的，beforeEach 可能先于它跑
    appState: {
      settings: { update: { enabled: true, mode: 'notify', endpoint: 'http://update.intranet.local/app' } },
      info: { version: '0.0.0-test' },
    } as { settings: { update: Record<string, unknown> }; info: { version: string } | null },
  }
})

vi.mock('@/api', () => ({ bridge: fakes.bridge, platform: 'tauri' }))
vi.mock('@/infra/update', () => ({ updateClient: vi.fn(() => ({ bootstrapped: true })) }))
vi.mock('@/orchestrator/update', async () => {
  const actual = await vi.importActual<typeof import('@/orchestrator/update')>('@/orchestrator/update')
  // 只替掉工厂：emptyStatus / 类型保持真值，避免用假状态掩盖真实契约。
  // 依赖**必须原样透传**，否则 store 装配的 loadState/saveState/pauseServices 无从断言。
  return { ...actual, createUpdater: (deps: unknown) => fakes.createUpdater(deps) }
})
vi.mock('@/stores/app', async () => {
  const { reactive } = await import('vue')
  // reactive(proxy) 返回同一个代理：多次进工厂也只包一层，beforeEach 的赋值照常生效
  fakes.appState = reactive(fakes.appState)
  return { useAppStore: () => fakes.appState }
})
vi.mock('@/stores/codehub', () => ({ useCodehubStore: () => fakes.codehub }))
vi.mock('@/stores/welink', () => ({ useWelinkStore: () => fakes.welink }))
vi.mock('@/utils/logger', () => ({ logger: fakes.logger }))

/** 每个用例都重新装配模块：store 的 updaterHolder 是模块级单例，必须隔离 */
async function fresh(): Promise<UpdateStoreApi> {
  vi.resetModules()
  const mod = await import('./update')
  setActivePinia(createPinia())
  return mod.useUpdateStore() as unknown as UpdateStoreApi
}

function deps(): {
  pauseServices: () => Promise<void>
  loadState: () => Promise<unknown>
  saveState: (state: unknown) => Promise<void>
  notify?: (title: string, body: string) => void
  currentVersion: string
  settings: () => unknown
} {
  return fakes.createUpdater.mock.calls[0][0] as never
}

function setStatus(patch: Partial<UpdateStatus>): void {
  const handler = fakes.updater.onStatus.mock.calls.at(-1)?.[0]
  handler?.({ ...fakes.empty(), ...patch })
}

describe('stores/update —— 聚合口径', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    fakes.updater.getStatus.mockReturnValue(fakes.empty())
    fakes.appState.settings.update = { enabled: true, mode: 'notify', endpoint: 'http://update.intranet.local' }
    fakes.appState.info = { version: '0.0.0-test' }
  })

  it('hasUpdate：available / ready 为真（小红点与设置卡的共同判据）', async () => {
    const store = await fresh()
    store.init()
    setStatus({ state: 'available' })
    expect(store.hasUpdate).toBe(true)
    setStatus({ state: 'ready' })
    expect(store.hasUpdate).toBe(true)
  })

  it('hasUpdate：摆渡提示（hintVersion 非空）也算有更新', async () => {
    const store = await fresh()
    store.init()
    setStatus({ hintVersion: '0.2.0' })
    expect(store.hasUpdate).toBe(true)
  })

  it('hasUpdate：开关关闭时恒为 false（关了更新不该再显示红点）', async () => {
    const store = await fresh()
    store.init()
    setStatus({ state: 'available', hintVersion: '0.2.0' })
    expect(store.hasUpdate).toBe(true)
    fakes.appState.settings.update = { enabled: false }
    expect(store.hasUpdate).toBe(false)
  })

  it('busy：checking/downloading/verifying/applying 为真，idle 与 failed 为假', async () => {
    const store = await fresh()
    store.init()
    for (const state of ['checking', 'downloading', 'verifying', 'applying'] as const) {
      setStatus({ state })
      expect(store.busy).toBe(true)
    }
    setStatus({ state: 'idle' })
    expect(store.busy).toBe(false)
    setStatus({ state: 'failed' })
    expect(store.busy).toBe(false)
  })
})

describe('stores/update —— 装配与韧性', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    fakes.updater.getStatus.mockReturnValue(fakes.empty())
    fakes.appState.settings.update = { enabled: true, mode: 'notify', endpoint: 'http://update.intranet.local' }
    fakes.appState.info = { version: '0.0.0-test' }
  })

  it('init() 装配幂等：多次调用只建一个 updater（调度自身幂等由编排层保证）', async () => {
    const store = await fresh()
    store.init()
    store.init()
    expect(fakes.createUpdater).toHaveBeenCalledTimes(1)
    expect(fakes.updater.init).toHaveBeenCalledTimes(2)
  })

  it('init() 装配抛错只 warn 不抛（更新本次不可用，不得带崩应用启动）', async () => {
    fakes.createUpdater.mockImplementationOnce(() => {
      throw new Error('装配失败')
    })
    const store = await fresh()
    expect(() => store.init()).not.toThrow()
    expect(fakes.logger.warn).toHaveBeenCalledWith(expect.stringContaining('更新编排装配失败'), expect.anything())
  })

  it('loadState：文件为空 → null（首次启动没有持久化状态是常态）', async () => {
    const store = await fresh()
    fakes.bridge.fsRead.mockResolvedValue('')
    store.init()
    await expect(deps().loadState()).resolves.toBeNull()
  })

  it('loadState：读回的不是 JSON → null 而不是崩（文件被截断/手工编辑过）', async () => {
    const store = await fresh()
    fakes.bridge.fsRead.mockResolvedValue('{ 半截内容')
    store.init()
    await expect(deps().loadState()).resolves.toBeNull()
  })

  it('loadState / saveState 走 update/state.json（路径与格式单一真值）', async () => {
    const store = await fresh()
    fakes.bridge.fsRead.mockResolvedValue(JSON.stringify({ hintVersion: '0.2.0' }))
    store.init()
    await expect(deps().loadState()).resolves.toEqual({ hintVersion: '0.2.0' })
    expect(fakes.bridge.fsRead).toHaveBeenCalledWith('update/state.json')

    await deps().saveState({ hintVersion: '0.3.0' })
    expect(fakes.bridge.fsWrite).toHaveBeenCalledWith('update/state.json', expect.stringContaining('0.3.0'))
  })

  it('notify 走系统通知通道（失败档要能被看见）', async () => {
    const store = await fresh()
    store.init()
    deps().notify?.('更新失败', '签名校验未通过')
    expect(fakes.bridge.notifySend).toHaveBeenCalledWith('更新失败', '签名校验未通过')
  })

  it('currentVersion 取 appInfo 的版本号（与 exe 实际版本同源）', async () => {
    const store = await fresh()
    store.init()
    expect(deps().currentVersion).toBe('0.0.0-test')
  })

  it('appInfo 缺失时回落到构建期注入的 __APP_VERSION__', async () => {
    fakes.appState.info = null
    const store = await fresh()
    store.init()
    expect(deps().currentVersion).toBe(__APP_VERSION__)
  })
})

describe('stores/update —— U-J：apply 前停服务', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    fakes.updater.getStatus.mockReturnValue(fakes.empty())
    fakes.welink.runtimeRunning.mockReturnValue(true)
  })

  it('WeLink 运行中 → 先停 WeLink，再停 CodeHub 自动同步', async () => {
    const store = await fresh()
    store.init()
    await deps().pauseServices()
    expect(fakes.welink.stop).toHaveBeenCalledTimes(1)
    expect(fakes.codehub.stopAuto).toHaveBeenCalledTimes(1)
  })

  it('WeLink 未运行 → 不停 WeLink（重启后由各域 bootstrap 恢复，别停出副作用）', async () => {
    fakes.welink.runtimeRunning.mockReturnValue(false)
    const store = await fresh()
    store.init()
    await deps().pauseServices()
    expect(fakes.welink.stop).not.toHaveBeenCalled()
    expect(fakes.codehub.stopAuto).toHaveBeenCalledTimes(1)
  })
})

describe('stores/update —— 动作透传', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    fakes.updater.getStatus.mockReturnValue(fakes.empty())
  })

  it('checkNow / install / scanInbox 各自透传给编排层（store 只做转发，不夹带逻辑）', async () => {
    const store = await fresh()
    await store.checkNow()
    expect(fakes.updater.checkNow).toHaveBeenCalledWith('manual')
    await store.install()
    expect(fakes.updater.install).toHaveBeenCalledTimes(1)
    await store.scanInbox()
    expect(fakes.updater.scanInbox).toHaveBeenCalledTimes(1)
  })

  it('updater 的 status 变化经 onStatus 回流到 store（UI 读的是 store 而非编排层）', async () => {
    const store = await fresh()
    store.init()
    setStatus({ state: 'downloading' })
    expect(store.status.state).toBe('downloading')
    expect(store.busy).toBe(true)
  })

  it('Updater 接口形状被钉住（缺一个方法就装不上，防止编排层改签名后 UI 静默空转）', async () => {
    const store = await fresh()
    store.init()
    const updater = fakes.updater as unknown as Updater
    for (const method of ['init', 'getStatus', 'onStatus', 'checkNow', 'install', 'scanInbox', 'dispose'] as const) {
      expect(typeof updater[method]).toBe('function')
    }
  })
})
