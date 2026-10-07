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

  it('硬超时：全部「永不 reject」方法的失败折叠路径各自生效（fake timers）', async () => {
    // 逐方法驱动 withHardTimeouts 的失败折叠回调——此前这些箭头与成功路径同行
    // 被 v8 覆盖率顺带计入，格式化拆行后暴露为未覆盖（见 verify 阶段 4 阈值回归）。
    const hung = createWindowsInfra({ mode: 'mock', hardTimeoutMs: 100, mock: { delayMs: 50_000 } })
    const cases: Array<Promise<unknown>> = [
      hung.probeOverview(),
      hung.probeEnvVar('PATH'),
      hung.openWithDefault('C:\\报告.pdf'),
      hung.readClipboard(),
      hung.writeClipboard('内容'),
      hung.notify('标题', '正文'),
    ]
    const assertion = Promise.all(cases.map((pending) => expect(pending).resolves.toMatchObject({ ok: false })))
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
