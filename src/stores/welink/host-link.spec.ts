import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick, reactive, ref, type Ref } from 'vue'

/**
 * host-link 联动层的黑盒测试（service-residency §10.3，假 bridge 驱动）：
 *  * 状态回显：status watch → traySetStatus，覆盖 immediate 与迁移路径；
 *  * tray-toggle 双向切换：runtimeRunning 为唯一判据，stop/start 各调一次；
 *  * window-shown：强制复位页面可见性（唤回兜底）；
 *  * 退订：dispose 后事件与 watch 全部断开；dispose 先于订阅注册也安全。
 *
 * 假 store 用 reactive 包 Ref 模拟 Pinia 的解包语义（store.status 读到的是值，
 * 写 ref.value 触发 watch）——这与真实 store 的行为一致，测试不必拉起整个 Pinia。
 */

const { bridgeMock, loggerMock } = vi.hoisted(() => ({
  bridgeMock: {
    onHostEvent: vi.fn(),
    traySetStatus: vi.fn(),
  },
  loggerMock: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}))

vi.mock('@/api', () => ({ bridge: bridgeMock }))
vi.mock('@/utils/logger', () => ({ logger: loggerMock }))

import { bindHostLink } from './host-link'
import type { RuntimeStatus } from './aggregate'

/** bindHostLink 的形参类型（真实 Pinia store 类型；测试里用鸭子类型替身满足它） */
type StoreLike = Parameters<typeof bindHostLink>[0]

interface Harness {
  status: Ref<RuntimeStatus>
  store: StoreLike
  handlers: Map<string, () => void>
  stop: ReturnType<typeof vi.fn>
  start: ReturnType<typeof vi.fn>
  setPageVisible: ReturnType<typeof vi.fn>
  runtimeRunning: ReturnType<typeof vi.fn>
}

function makeHarness(initialStatus: RuntimeStatus = 'stopped', running = false): Harness {
  const status = ref<RuntimeStatus>(initialStatus)
  const stop = vi.fn()
  const start = vi.fn(async () => null)
  const setPageVisible = vi.fn()
  const runtimeRunning = vi.fn(() => running)
  const handlers = new Map<string, () => void>()
  bridgeMock.onHostEvent.mockImplementation((name: string, handler: () => void) => {
    handlers.set(name, handler)
    return Promise.resolve(() => handlers.delete(name))
  })
  // reactive 解包 status ref，模拟 Pinia store 的属性访问语义
  const store = reactive({ status, runtimeRunning, stop, start, setPageVisible })
  return { status, store: store as unknown as StoreLike, handlers, stop, start, setPageVisible, runtimeRunning }
}

/** 清空微任务队列：onHostEvent 的 .then 退订注册需要一次 flush 才落位 */
async function flushMicrotasks() {
  await Promise.resolve()
  await Promise.resolve()
}

describe('host-link：状态回显', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('immediate：装配即回写一次托盘状态（running 判据来自 runtimeRunning）', () => {
    const harness = makeHarness('stopped', false)
    const dispose = bindHostLink(harness.store)
    expect(bridgeMock.traySetStatus).toHaveBeenCalledWith(false, '服务已停止')
    dispose()
  })

  it('状态迁移回显：文案随 status 变化，并落盘 info 日志', async () => {
    const harness = makeHarness('stopped', false)
    const dispose = bindHostLink(harness.store)
    bridgeMock.traySetStatus.mockClear()
    loggerMock.info.mockClear()

    harness.status.value = 'running'
    harness.runtimeRunning.mockReturnValue(true)
    await nextTick()

    expect(bridgeMock.traySetStatus).toHaveBeenCalledWith(true, '服务运行中')
    expect(loggerMock.info).toHaveBeenCalledTimes(1)
    expect(loggerMock.info).toHaveBeenCalledWith(expect.stringContaining('服务已停止 → 服务运行中'))
    dispose()
  })

  it('急停状态回显为「急停（人工确认模式）」', async () => {
    const harness = makeHarness('running', true)
    const dispose = bindHostLink(harness.store)
    bridgeMock.traySetStatus.mockClear()

    harness.status.value = 'panic'
    await nextTick()

    expect(bridgeMock.traySetStatus).toHaveBeenCalledWith(true, '急停（人工确认模式）')
    dispose()
  })
})

describe('host-link：托盘动作', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('tray-toggle：服务在跑 → 只 stop（暂停）', async () => {
    const harness = makeHarness('running', true)
    const dispose = bindHostLink(harness.store)
    await flushMicrotasks()

    harness.handlers.get('host://tray-toggle')?.()

    expect(harness.stop).toHaveBeenCalledTimes(1)
    expect(harness.start).not.toHaveBeenCalled()
    dispose()
  })

  it('tray-toggle：服务停止 → start（完整 bootstrap 恢复，非裸续跑）', async () => {
    const harness = makeHarness('stopped', false)
    const dispose = bindHostLink(harness.store)
    await flushMicrotasks()

    harness.handlers.get('host://tray-toggle')?.()

    expect(harness.start).toHaveBeenCalledTimes(1)
    expect(harness.stop).not.toHaveBeenCalled()
    dispose()
  })

  it('window-shown：强制复位页面可见性（唤回兜底，×3 降频不再残留）', async () => {
    const harness = makeHarness()
    const dispose = bindHostLink(harness.store)
    await flushMicrotasks()

    harness.handlers.get('host://window-shown')?.()

    expect(harness.setPageVisible).toHaveBeenCalledWith(true)
    dispose()
  })
})

describe('host-link：退订', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('dispose 后：宿主事件断开、status watch 停止回显', async () => {
    const harness = makeHarness('stopped', false)
    const dispose = bindHostLink(harness.store)
    await flushMicrotasks()

    dispose()
    bridgeMock.traySetStatus.mockClear()

    harness.handlers.get('host://tray-toggle')?.()
    harness.status.value = 'running'
    await nextTick()

    expect(bridgeMock.traySetStatus).not.toHaveBeenCalled()
    expect(harness.stop).not.toHaveBeenCalled()
    expect(harness.start).not.toHaveBeenCalled()
  })

  it('dispose 先于订阅注册完成（同步退出场景）：注册落地时立即退订', async () => {
    const harness = makeHarness()
    const dispose = bindHostLink(harness.store)
    // 不 flush：此刻 onHostEvent 的 .then 还没执行，退订函数尚未入列
    dispose()
    await flushMicrotasks()

    // 退订注册落地时 disposed 已为 true → 直接调用 unlisten（handlers 被清空）
    expect(harness.handlers.has('host://tray-toggle')).toBe(false)
    expect(harness.handlers.has('host://window-shown')).toBe(false)
  })
})
