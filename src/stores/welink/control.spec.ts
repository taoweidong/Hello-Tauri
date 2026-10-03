import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ref, type Ref } from 'vue'

import type { BootstrapReport } from '@/orchestrator/bootstrap'
import { emptySummary, type ConversationState, type SafetySnapshot } from '@/orchestrator/events'
import type { WelinkRuntime } from '@/orchestrator/runtime'
import { DEFAULT_WELINK_SETTINGS, type WelinkSettings } from '@/types/welink'
import type { RuntimeStatus } from './aggregate'
import { createRuntimeControl, type RuntimeControlDeps } from './control'

const { ensureWelinkStorageMock } = vi.hoisted(() => ({
  ensureWelinkStorageMock: vi.fn(async (): Promise<number[]> => []),
}))

vi.mock('@/orchestrator/welink-storage', () => ({
  ensureWelinkStorage: () => ensureWelinkStorageMock(),
}))

function report(overrides: Partial<BootstrapReport> = {}): BootstrapReport {
  return {
    recoveredSent: 0,
    requeued: 0,
    enqueued: 0,
    failed: 0,
    warnings: [],
    ...overrides,
  } as BootstrapReport
}

interface Harness {
  deps: RuntimeControlDeps
  runtime: WelinkRuntime
  pushLog: ReturnType<typeof vi.fn>
  status: Ref<RuntimeStatus>
  settings: Ref<WelinkSettings>
}

function makeHarness(): Harness {
  const snapshot: SafetySnapshot = {
    panic: false,
    globalCount: 0,
    globalCap: 10,
    globalClosedUntil: null,
    convCounts: {},
    fuses: [],
    globalFuse: false,
    globalFuseReason: '',
  }
  const runtime = {
    running: vi.fn(() => true),
    start: vi.fn(async () => report()),
    stop: vi.fn(),
    reload: vi.fn(),
    pullNow: vi.fn(async () => ({ ...emptySummary(), polled: 1 })),
    setVisible: vi.fn(),
    gate: {
      setPanic: vi.fn(),
      resetFuse: vi.fn(),
      snapshot: vi.fn(() => snapshot),
    },
  } as unknown as WelinkRuntime
  const pushLog = vi.fn()
  const status = ref<RuntimeStatus>('idle')
  const settings = ref<WelinkSettings>({ ...DEFAULT_WELINK_SETTINGS })
  const deps: RuntimeControlDeps = {
    status,
    settings,
    safety: ref<SafetySnapshot>({
      panic: false,
      globalCount: 0,
      globalCap: 10,
      globalClosedUntil: null,
      convCounts: {},
      fuses: [],
      globalFuse: false,
      globalFuseReason: '',
    }),
    fuseBanner: ref(null),
    pullSummary: ref(emptySummary()),
    pulling: ref(false),
    bootstrapReport: ref(null),
    convoStates: ref<Record<string, ConversationState>>({}),
    runtimeHolder: { current: null },
    ensureRuntime: async () => runtime,
    ensureLogSubscription: vi.fn(),
    pushLog,
    loadConversations: vi.fn(async () => {}),
    refreshReviewCount: vi.fn(async () => {}),
    refreshSafety: vi.fn(async () => {}),
  }
  return { deps, runtime, pushLog, status, settings }
}

describe('control：生命周期', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('init：装配日志旁路 + 迁移 + 装载 + 安全快照；开关关闭 → stopped', async () => {
    const harness = makeHarness()
    const control = createRuntimeControl(harness.deps)
    const result = await control.init()
    expect(harness.deps.ensureLogSubscription).toHaveBeenCalledTimes(1)
    expect(ensureWelinkStorageMock).toHaveBeenCalledTimes(1)
    expect(harness.deps.loadConversations).toHaveBeenCalledTimes(1)
    expect(harness.status.value).toBe('stopped')
    expect(result.panicRecovered).toBe(false)
  })

  it('init：读到落盘的 panicked 标记 → 强制 manual 并复位（评审 P1）', async () => {
    const harness = makeHarness()
    harness.settings.value.panicked = true
    const control = createRuntimeControl(harness.deps)
    const result = await control.init({ panicked: true, sendMode: 'auto' })
    expect(result.panicRecovered).toBe(true)
    expect(harness.settings.value.sendMode).toBe('manual')
    expect(harness.settings.value.panicked).toBe(false)
  })

  it('迁移失败：降级为 error 日志而不炸 init（页面仍可打开）', async () => {
    const harness = makeHarness()
    ensureWelinkStorageMock.mockRejectedValueOnce(new Error('no such table'))
    const control = createRuntimeControl(harness.deps)
    await expect(control.init()).resolves.toMatchObject({ panicRecovered: false })
    expect(harness.pushLog).toHaveBeenCalledWith('error', expect.stringContaining('表结构初始化失败'))
  })

  it('start：成功路径落报告、warn 入日志、状态灯更新', async () => {
    const harness = makeHarness()
    const control = createRuntimeControl(harness.deps)
    ;(harness.runtime.start as ReturnType<typeof vi.fn>).mockResolvedValue(
      report({ warnings: ['⚠ 时钟偏移'], requeued: 2 }),
    )
    const result = await control.start()
    expect(result?.warnings).toEqual(['⚠ 时钟偏移'])
    expect(harness.pushLog).toHaveBeenCalledWith('warn', '⚠ 时钟偏移')
    expect(harness.pushLog).toHaveBeenCalledWith('info', expect.stringContaining('回落重发 2'))
    expect(harness.deps.bootstrapReport.value).toBeTruthy()
  })

  it('start：编排层抛错 → 状态灯 stopped + 错误日志，返回 null', async () => {
    const harness = makeHarness()
    const control = createRuntimeControl(harness.deps)
    ;(harness.runtime.start as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('boom'))
    await expect(control.start()).resolves.toBeNull()
    expect(harness.status.value).toBe('stopped')
    expect(harness.pushLog).toHaveBeenCalledWith('error', expect.stringContaining('boom'))
  })

  it('stop：停调度、数据保留、日志提示', () => {
    const harness = makeHarness()
    harness.deps.runtimeHolder.current = harness.runtime
    const control = createRuntimeControl(harness.deps)
    control.stop()
    expect(harness.runtime.stop).toHaveBeenCalledTimes(1)
    expect(harness.status.value).toBe('stopped')
  })
})

describe('control：L0 急停与熔断', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('panicStop：封死 Gate + 停调度 + 落盘标记 + 状态灯 panic', () => {
    const harness = makeHarness()
    harness.deps.runtimeHolder.current = harness.runtime
    const control = createRuntimeControl(harness.deps)
    control.panicStop()
    expect(harness.runtime.gate.setPanic).toHaveBeenCalledWith(true)
    expect(harness.runtime.stop).toHaveBeenCalledTimes(1)
    expect(harness.settings.value.panicked).toBe(true)
    expect(harness.status.value).toBe('panic')
  })

  it('liftPanic：解除后自动降为 manual（防解除即爆量）', () => {
    const harness = makeHarness()
    harness.deps.runtimeHolder.current = harness.runtime
    const control = createRuntimeControl(harness.deps)
    const result = control.liftPanic()
    expect(harness.runtime.gate.setPanic).toHaveBeenCalledWith(false)
    expect(result.sendMode).toBe('manual')
    expect(harness.settings.value.sendMode).toBe('manual')
    expect(harness.status.value).toBe('running')
  })

  it('resetFuse：清横幅 + 刷新安全快照', () => {
    const harness = makeHarness()
    harness.deps.runtimeHolder.current = harness.runtime
    const control = createRuntimeControl(harness.deps)
    control.resetFuse('全局')
    expect(harness.runtime.gate.resetFuse).toHaveBeenCalledWith('全局')
    expect(harness.deps.refreshSafety).toHaveBeenCalledTimes(1)
  })
})

describe('control：状态灯推导与立即拉取', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('updateRuntimeStatus 四分支：panic > stopped > backoff > running', () => {
    const harness = makeHarness()
    const control = createRuntimeControl(harness.deps)
    const states = harness.deps.convoStates

    harness.deps.safety.value = { ...harness.deps.safety.value, panic: true }
    control.updateRuntimeStatus()
    expect(harness.status.value).toBe('panic')

    harness.deps.safety.value = { ...harness.deps.safety.value, panic: false }
    control.updateRuntimeStatus() // runtime 未装配
    expect(harness.status.value).toBe('stopped')

    harness.deps.runtimeHolder.current = harness.runtime
    states.value = { 'G-1': { state: 'backoff', failCount: 1, backoffSec: 30, reason: 'x', lastOkAt: '' } as ConversationState }
    control.updateRuntimeStatus()
    expect(harness.status.value).toBe('backoff')

    states.value = { 'G-1': { state: 'ok', failCount: 0, backoffSec: 0, reason: '', lastOkAt: '' } as ConversationState }
    control.updateRuntimeStatus()
    expect(harness.status.value).toBe('running')
  })

  it('pullNow：无 runtime 时返回空汇总且不置 pulling', async () => {
    const harness = makeHarness()
    const control = createRuntimeControl(harness.deps)
    const summary = await control.pullNow()
    expect(summary).toEqual(emptySummary())
    expect(harness.deps.pulling.value).toBe(false)
  })

  it('pullNow：拉取 → 落汇总 → 重载视图；finally 收起 pulling', async () => {
    const harness = makeHarness()
    harness.deps.runtimeHolder.current = harness.runtime
    const control = createRuntimeControl(harness.deps)
    const summary = await control.pullNow()
    expect(summary.polled).toBe(1)
    expect(harness.deps.pullSummary.value).toEqual(summary)
    expect(harness.deps.loadConversations).toHaveBeenCalledTimes(1)
    expect(harness.deps.pulling.value).toBe(false)
  })

  it('setPageVisible：透传编排层（视图不持有计时器，P9）', () => {
    const harness = makeHarness()
    harness.deps.runtimeHolder.current = harness.runtime
    const control = createRuntimeControl(harness.deps)
    control.setPageVisible(false)
    expect(harness.runtime.setVisible).toHaveBeenCalledWith(false)
  })
})
