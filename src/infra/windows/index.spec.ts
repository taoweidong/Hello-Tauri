import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createWindowsInfra } from './index'
import { HARD_TIMEOUT_MS } from './port'

describe('windows 基础设施工厂', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('mode=mock：产出 [MOCK-WIN] 端口，不触碰 Bridge', async () => {
    const infra = createWindowsInfra({ mode: 'mock' })
    const overview = await infra.probeOverview()
    expect(overview.ok).toBe(true)
    if (overview.ok) expect(overview.data.osName).toContain('[MOCK-WIN]')
  })

  it('mode=bridge：真实端口经 Bridge（测试环境走 webBridge → 浏览器等价语义的 [MOCK-WIN] 数据）', async () => {
    const infra = createWindowsInfra({ mode: 'bridge' })
    const overview = await infra.probeOverview()
    expect(overview.ok).toBe(true)
    if (overview.ok) expect(overview.data.osName).toContain('[MOCK-WIN]')
  })

  it('硬超时：挂死的探测在预算后折叠为失败结果（fake timers）', async () => {
    const hung = createWindowsInfra({ mode: 'mock', hardTimeoutMs: 100, mock: { delayMs: 50_000 } })
    const pending = hung.probeDisks()
    const assertion = expect(pending).resolves.toMatchObject({ ok: false })
    await vi.advanceTimersByTimeAsync(101)
    await assertion
  })

  it('硬超时：挂死的命令执行折叠为 timedOut 结果而不是挂死（fake timers）', async () => {
    const hung = createWindowsInfra({ mode: 'mock', hardTimeoutMs: 100, mock: { delayMs: 50_000 } })
    const pending = hung.runCommand('whoami')
    const assertion = expect(pending).resolves.toMatchObject({ timedOut: true, exitCode: null })
    await vi.advanceTimersByTimeAsync(101)
    await assertion
  })

  it('正常路径不受硬超时影响，且定时器不泄漏（多次调用后无 pending timer）', async () => {
    const infra = createWindowsInfra({ mode: 'mock', hardTimeoutMs: 1000 })
    for (let index = 0; index < 3; index += 1) {
      await infra.probeOverview()
    }
    expect(vi.getTimerCount()).toBe(0)
  })

  it('默认硬超时大于最大登记命令预算（注册表契约的工厂侧保障）', () => {
    expect(HARD_TIMEOUT_MS).toBeGreaterThan(10_000)
  })
})
