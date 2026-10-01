import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

/**
 * 环境检测 store 单测：状态机与竞态守卫。
 *
 * 通过 vi.mock 把 `createEnvChecks` 换成**脚本化探测器**（可注入延迟与结论），
 * 专门覆盖探测实现无法表达的时序场景：
 *  * 代次守卫 —— 后一轮比前一轮先完成时，前一轮的迟到结果必须被丢弃
 *    （守卫坏了的表现是「重测后先闪现旧结论再被更旧的结果覆盖」）；
 *  * cancelPending —— 未决结果作废，迟到结果不复活；
 *  * overall 汇总 —— partial / warn / fail 的判定边界。
 */
const scenario = vi.hoisted(() => ({
  delays: {} as Record<string, number>,
  outcomes: {} as Record<string, { status: 'ok' | 'warn' | 'fail' | 'timeout'; summary: string }>,
}))

const createEnvChecks = vi.hoisted(() => vi.fn())

vi.mock('@/api', () => ({
  bridge: { cliRun: vi.fn() },
  platform: 'web',
}))

// store 只在运行期消费 createEnvChecks（类型导入会被擦除，无需在 mock 里提供）
vi.mock('@/infra/envcheck', () => ({ createEnvChecks }))

import type { EnvCheckItem, EnvCheckOutcome } from '@/infra/envcheck'
import { useAppStore } from '@/stores/app'
import { useEnvCheckStore } from '@/stores/envcheck'

/** 脚本化探测器：两项（welink-cli / second-cli），delay 在 run 进入时才读取 ——
 *  这样两轮 runAll 各自固定住自己启动那一刻的延迟，代次守卫用例才能构造
 *  「第一轮慢、第二轮快」的时序；按项注入延迟则用于构造「部分完成」场景 */
function scriptedChecks(): EnvCheckItem[] {
  return ['welink-cli', 'second-cli'].map((id) => ({
    id,
    name: id,
    description: `${id} 探测`,
    run: async (): Promise<EnvCheckOutcome> => {
      const delay = scenario.delays[id] ?? 0
      if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay))
      const base = scenario.outcomes[id] ?? { status: 'ok' as const, summary: `${id} 正常` }
      return { ...base, steps: [], durationMs: 1 }
    },
  }))
}

async function flush(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

beforeEach(() => {
  setActivePinia(createPinia())
  scenario.delays = {}
  scenario.outcomes = {}
  createEnvChecks.mockReset()
  createEnvChecks.mockImplementation(scriptedChecks)
})

describe('stores/envcheck —— runAll 全量检测', () => {
  it('全部通过 → pass，逐项落结果，记录最近检测时间', async () => {
    const store = useEnvCheckStore()
    await store.runAll()
    expect(store.items).toHaveLength(2)
    expect(store.items.every((item) => item.status === 'ok')).toBe(true)
    expect(store.overall).toBe('pass')
    expect(store.lastRunAt).toBeTruthy()
    expect(store.running).toBe(false)
  })

  it('把 appStore 里的 cliPath 透传给注册表工厂（mode 按平台决定）', async () => {
    const appStore = useAppStore()
    appStore.settings.weLink = { cliPath: 'C:/tools/welink-cli.exe' }
    const store = useEnvCheckStore()
    await store.runAll()
    expect(createEnvChecks).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'mock', welink: { cliPath: 'C:/tools/welink-cli.exe' } }),
    )
  })

  it('fail / warn / timeout 都归入对应汇总档位', async () => {
    const store = useEnvCheckStore()

    scenario.outcomes['welink-cli'] = { status: 'warn', summary: '有告警' }
    await store.runAll()
    expect(store.overall).toBe('warn')

    scenario.outcomes['welink-cli'] = { status: 'timeout', summary: '超时' }
    await store.runAll()
    expect(store.overall).toBe('fail')

    scenario.outcomes['welink-cli'] = { status: 'fail', summary: '失败' }
    await store.runAll()
    expect(store.overall).toBe('fail')
  })
})

describe('stores/envcheck —— 代次守卫（竞态）', () => {
  it('重测后先启动的慢结果被丢弃，不被它覆盖新结论', async () => {
    const store = useEnvCheckStore()
    // 第一轮：慢（80ms）；第二轮：快（10ms）—— 无守卫时第一轮的迟到结果会最后落地
    scenario.delays = { 'welink-cli': 80, 'second-cli': 80 }
    scenario.outcomes['welink-cli'] = { status: 'fail', summary: '第一轮（过期）' }
    const first = store.runAll()
    await flush(5)

    scenario.delays = { 'welink-cli': 10, 'second-cli': 10 }
    scenario.outcomes['welink-cli'] = { status: 'ok', summary: '第二轮（最新）' }
    const second = store.runAll()

    await Promise.all([first, second])
    const state = store.items.find((item) => item.id === 'welink-cli')
    expect(state?.summary).toBe('第二轮（最新）')
    expect(state?.status).toBe('ok')
    expect(store.overall).toBe('pass')
  })
})

describe('stores/envcheck —— cancelPending（取消未决）', () => {
  it('取消后 running 项复位为 idle，迟到的结果不复活', async () => {
    const store = useEnvCheckStore()
    scenario.delays = { 'welink-cli': 60, 'second-cli': 60 }
    const pending = store.runAll()
    await flush(5)
    expect(store.running).toBe(true)

    store.cancelPending()
    const cancelled = store.items.find((item) => item.id === 'welink-cli')
    expect(cancelled?.status).toBe('idle')
    expect(cancelled?.summary).toContain('已取消')

    // 迟到结果到达（若无代次守卫会在这里变回 ok）
    await pending
    expect(store.items.find((item) => item.id === 'welink-cli')?.status).toBe('idle')
    expect(store.overall).toBe('idle')
  })

  it('部分完成（其他项已有结果）时汇总为 partial 而不是 idle', async () => {
    const store = useEnvCheckStore()
    scenario.delays = { 'welink-cli': 60, 'second-cli': 0 }
    scenario.outcomes['second-cli'] = { status: 'ok', summary: '已完成' }
    const pending = store.runAll()
    await flush(20) // second-cli（无延迟）先完成并上屏，welink-cli 仍在跑
    store.cancelPending()
    await pending
    // welink-cli 被取消回 idle，second-cli 保留 ok —— 横幅要如实提示「未完成全部检测」
    expect(store.overall).toBe('partial')
  })
})

describe('stores/envcheck —— runOne 单项重测', () => {
  it('只更新目标项，其余保持未检测 → 汇总 partial', async () => {
    const store = useEnvCheckStore()
    scenario.outcomes['welink-cli'] = { status: 'ok', summary: '单项通过' }
    await store.runOne('welink-cli')

    const target = store.items.find((item) => item.id === 'welink-cli')
    const other = store.items.find((item) => item.id === 'second-cli')
    expect(target?.status).toBe('ok')
    expect(target?.summary).toBe('单项通过')
    expect(other?.status).toBe('idle')
    expect(store.overall).toBe('partial')
  })

  it('未知 ID 是安全的 no-op（清单已装配但无人被置为 running）', async () => {
    const store = useEnvCheckStore()
    await store.runOne('nope')
    expect(store.items).toHaveLength(2)
    expect(store.items.every((item) => item.status === 'idle')).toBe(true)
  })
})
