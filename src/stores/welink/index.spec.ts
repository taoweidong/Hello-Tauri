import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

/**
 * WeLink store 装配层测试（S-02 / D-9 / 幂等装配）。
 *
 * * 为什么单独立一个文件：`index.ts` 是 welink store 的唯一公共 facade，它承担的
 *   三件装配事务（runtime 幂等、建群闸门共享、日志旁路幂等）**没有对应的实现层
 *   spec** —— view/control/events/data 各自测自己的域，装配点本身是真空。
 *   而这三件恰恰是「错了不报错、只是行为静默偏移」的类型：
 *   runtime 重复建 = 两套 poller 抢同一批会话；闸门不共享 = 一键全停封不住建群；
 *   日志订阅叠加 = 同一条日志在运行区里出现 N 次。
 * * 断言口径：全部钉**行为后果**（工厂调用次数、注入的实例同一性、日志条数），
 *   不钉内部实现细节。
 */

const mocks = vi.hoisted(() => ({
  createWelinkRuntime: vi.fn(),
  setGroupGate: vi.fn(),
  getWelinkRepo: vi.fn(),
  ensureWelinkStorage: vi.fn(async (): Promise<number[]> => []),
}))

vi.mock('@/orchestrator/welink-storage', () => ({
  ensureWelinkStorage: () => mocks.ensureWelinkStorage(),
  getWelinkRepo: () => mocks.getWelinkRepo(),
}))

vi.mock('@/orchestrator/runtime', () => ({
  createWelinkRuntime: (options: unknown) => mocks.createWelinkRuntime(options),
}))

// spy 记录参数**并转发真实实现**：让 group 模块的 sharedGate 真的切过去，
// 断言「同一性」的同时不破坏跨模块的真实装配行为
vi.mock('@/stores/group', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/stores/group')>()
  return {
    ...actual,
    setGroupGate: (gate: unknown) => {
      mocks.setGroupGate(gate)
      actual.setGroupGate(gate as Parameters<typeof actual.setGroupGate>[0])
    },
  }
})

vi.mock('@/api', () => ({
  platform: 'windows',
  bridge: { appendLog: vi.fn(() => Promise.resolve()) },
}))

import { useWelinkStore, subscribeWelinkLogs, unsubscribeWelinkLogs } from './index'
import { resetGroupGate } from '@/stores/group'
import { logger } from '@/utils/logger'
import type { WelinkRuntime } from '@/orchestrator/runtime'
import { emptySummary, type SafetySnapshot } from '@/orchestrator/events'

const SNAPSHOT: SafetySnapshot = {
  panic: false,
  globalCount: 0,
  globalCap: 10,
  globalClosedUntil: null,
  convCounts: {},
  fuses: [],
  globalFuse: false,
  globalFuseReason: '',
}

function fakeRuntime(): WelinkRuntime {
  const gate = {
    setPanic: vi.fn(),
    setEnabled: vi.fn(),
    reload: vi.fn(),
    snapshot: vi.fn(() => SNAPSHOT),
    cacheConversation: vi.fn(),
    invalidateConversation: vi.fn(),
    primeConversation: vi.fn(),
    primeGlobal: vi.fn(),
    onFuse: vi.fn(),
    check: vi.fn(() => ({ action: 'send', reason: '', detail: '放行' })),
    onSent: vi.fn(),
    fused: vi.fn(() => false),
    resetFuse: vi.fn(),
  }
  return {
    running: vi.fn(() => false),
    start: vi.fn(async () => ({
      recoveredSent: 0,
      requeued: 0,
      enqueued: 0,
      failed: 0,
      warnings: [],
    })),
    stop: vi.fn(),
    reload: vi.fn(),
    pullNow: vi.fn(async () => ({ ...emptySummary() })),
    setVisible: vi.fn(),
    gate,
    poller: {
      conversationState: vi.fn(() => 'idle'),
      currentStaggerMs: vi.fn(() => 0),
    },
  } as unknown as WelinkRuntime
}

function fakeRepo() {
  return {
    listConversations: vi.fn(async () => []),
    countConversations: vi.fn(async () => 0),
    countHolding: vi.fn(async () => 0),
    listJobs: vi.fn(async () => []),
    getConversation: vi.fn(async () => null),
    markRead: vi.fn(async () => {}),
    countMessages: vi.fn(async () => 0),
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  setActivePinia(createPinia())
  mocks.createWelinkRuntime.mockImplementation(() => fakeRuntime())
  mocks.getWelinkRepo.mockImplementation(() => fakeRepo())
})

afterEach(() => {
  // 模块级状态跨用例隔离：日志旁路单例 + 建群闸门共享实例
  unsubscribeWelinkLogs()
  resetGroupGate()
})

describe('welink store 装配不变量', () => {
  it('ensureRuntime 幂等：重复调用返回同一实例，工厂只建一次', async () => {
    /**
     * 反证口径：去掉 `runtimeHolder.current` 守卫后，本条两个断言都会红 ——
     * 两个 runtime = 两套 poller/pipeline 抢同一批会话（双轮询、双外发），
     * 且第二次 setGroupGate 会把建群闸门切到新实例，panic 同步出现断点。
     */
    const store = useWelinkStore()
    const first = await store.ensureRuntime()
    const second = await store.ensureRuntime()
    expect(second).toBe(first)
    expect(mocks.createWelinkRuntime).toHaveBeenCalledTimes(1)
  })

  it('ensureRuntime 把 runtime 的 gate 注入建群闸门（S-02 同一实例，一键全停封得住建群）', async () => {
    /**
     * 反证口径：删掉 ensureRuntime 里的 setGroupGate 调用后，本条两个断言都会红 ——
     * 建群闸门会退回自建实例，「一键全停只封消息不封建群」的漏洞复现。
     */
    const store = useWelinkStore()
    const runtime = await store.ensureRuntime()
    expect(mocks.setGroupGate).toHaveBeenCalledTimes(1)
    // 同一性断言：注入的必须是 runtime 自己的 gate，而不是另一个同形对象
    expect(mocks.setGroupGate.mock.calls[0][0]).toBe(runtime.gate)
  })

  it('日志旁路订阅不叠加：init + 重复 subscribe 后一条日志只进运行区一次', async () => {
    /**
     * 反证口径：去掉 ensureLogSubscription 里的 logUnsubscribe 守卫后，本条会红 ——
     * init 与两次 subscribe 各挂一个 sink，同一条日志在运行区出现 3 次，
     * 用户看到「失败原因」刷屏，还误以为发生了三次失败。
     */
    const store = useWelinkStore()
    await store.init()
    // keep-alive 复活路径：重复进入页面不应叠加订阅
    subscribeWelinkLogs()
    subscribeWelinkLogs()

    logger.info('装配层探针日志')
    expect(store.logs).toHaveLength(1)
    expect(store.logs[0].text).toContain('装配层探针日志')
  })
})
