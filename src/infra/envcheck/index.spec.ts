import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 环境检测注册表工厂单测：数据源选择 + 硬超时兜底。
 *
 *  * 浏览器平台默认 mock（web Bridge 的 cliRun 会明确报错，绝不走真实探测）；
 *  * 显式 mode 优先于平台；
 *  * **每一项都被硬超时包裹** —— 用永不 resolve 的 cliRun 验证「检测挂死也能
 *    按预算出 timeout 结论」，这是本模块对页面的核心承诺。
 */
const state = vi.hoisted(() => ({ platform: 'tauri' as 'tauri' | 'web' }))
const cliRun = vi.hoisted(() => vi.fn())

vi.mock('@/api', () => ({
  get platform() {
    return state.platform
  },
  bridge: { cliRun, appendLog: vi.fn(async () => '/tmp/log') },
}))

import { createEnvChecks, HARD_TIMEOUT_MS } from '@/infra/envcheck'
import { PYTHON_CHECK_ID } from '@/infra/envcheck/python'
import { WELINK_CHECK_ID } from '@/infra/envcheck/welink'

beforeEach(() => {
  cliRun.mockReset()
  state.platform = 'tauri'
})

describe('infra/envcheck —— createEnvChecks（注册表工厂）', () => {
  it('桌面平台默认走真实探测器（welink-cli + Python 两项）', () => {
    const items = createEnvChecks({ welink: { cliPath: 'C:\\x\\welink-cli.exe' } })
    expect(items.map((item) => item.id)).toEqual([WELINK_CHECK_ID, PYTHON_CHECK_ID])
    expect(items[0]?.description).toContain('C:\\x\\welink-cli.exe')
    expect(items[1]?.description).toContain('3.10')
  })

  it('浏览器平台默认走 mock（模拟结论可辨识，两项齐全）', async () => {
    state.platform = 'web'
    const items = createEnvChecks()
    expect(items.map((item) => item.id)).toEqual([WELINK_CHECK_ID, PYTHON_CHECK_ID])
    const outcome = await items[0]!.run()
    expect(outcome.status).toBe('ok')
    expect(outcome.summary).toContain('【模拟】')
    const pythonOutcome = await items[1]!.run()
    expect(pythonOutcome.status).toBe('ok')
    expect(pythonOutcome.summary).toContain('【模拟】')
  })

  it('显式 mode 优先于平台判定；mock 参数透传（overrides 生效）', async () => {
    const items = createEnvChecks({
      mode: 'mock',
      mock: { delayMs: 0, overrides: { [WELINK_CHECK_ID]: { status: 'warn', summary: '注入告警' } } },
    })
    const outcome = await items[0]!.run()
    expect(outcome.status).toBe('warn')
    expect(outcome.summary).toBe('注入告警')
  })

  it('每一项都被硬超时包裹：cliRun 永不返回也能按预算出 timeout 结论', async () => {
    cliRun.mockImplementation(() => new Promise(() => undefined)) // 模拟 bridge 挂死
    const items = createEnvChecks({ mode: 'cli', hardTimeoutMs: 60 })
    expect(HARD_TIMEOUT_MS).toBeGreaterThan(13_000) // 默认预算 > 两次内部调用之和（5s+8s）
    const outcome = await items[0]!.run()
    expect(outcome.status).toBe('timeout')
    expect(outcome.durationMs).toBeGreaterThanOrEqual(60)
  })

  it('默认硬超时生效：不传 hardTimeoutMs 时按 HARD_TIMEOUT_MS 折叠（fake timers 快进）', async () => {
    vi.useFakeTimers()
    try {
      cliRun.mockImplementation(() => new Promise(() => undefined)) // 模拟 bridge 挂死
      const items = createEnvChecks({ mode: 'cli' })
      const pending = items[0]!.run()
      const assertion = expect(pending).resolves.toMatchObject({
        status: 'timeout',
        durationMs: expect.any(Number),
      })
      await vi.advanceTimersByTimeAsync(HARD_TIMEOUT_MS)
      await assertion
      expect((await pending).durationMs).toBeGreaterThanOrEqual(HARD_TIMEOUT_MS)
    } finally {
      vi.useRealTimers()
    }
  })
})
