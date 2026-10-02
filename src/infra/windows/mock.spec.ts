import { describe, expect, it } from 'vitest'

import { createMockWindowsInfra } from './mock'

describe('[MOCK-WIN] windows 基础设施模拟实现', () => {
  it('runCommand：返回 canned 输出并记录调用', async () => {
    const mock = createMockWindowsInfra()
    const outcome = await mock.runCommand('ping-host', ['example.local'])
    expect(outcome.exitCode).toBe(0)
    expect(outcome.stdout).toContain('[MOCK-WIN]')
    expect(mock.state.executedCommands).toEqual([{ commandId: 'ping-host', extraArgs: ['example.local'] }])
  })

  it('runCommand：commandOutputs 覆盖 canned 输出（GBK/超时等场景注入）', async () => {
    const mock = createMockWindowsInfra({
      commandOutputs: {
        'system-info': {
          exitCode: null,
          stdout: '',
          stderr: '',
          stdoutTruncated: false,
          stderrTruncated: false,
          timedOut: true,
          durationMs: 10_000,
        },
      },
    })
    const outcome = await mock.runCommand('system-info')
    expect(outcome.timedOut).toBe(true)
    expect(outcome.exitCode).toBeNull()
  })

  it('runCommand：failCommands 注入通道故障（reject 路径）', async () => {
    const mock = createMockWindowsInfra({ failCommands: true })
    await expect(mock.runCommand('whoami')).rejects.toThrow('命令通道故障')
  })

  it('探测类：默认成功返回模拟数据；failProbes 折叠为 ok:false 而不 reject', async () => {
    const ok = createMockWindowsInfra()
    const overview = await ok.probeOverview()
    expect(overview.ok).toBe(true)
    if (overview.ok) expect(overview.data.hostname).toBe('mock-hostname')

    const failed = createMockWindowsInfra({ failProbes: true })
    const disks = await failed.probeDisks()
    expect(disks.ok).toBe(false)
    await expect(failed.probeDisks()).resolves.toHaveProperty('ok', false)
  })

  it('环境变量：PATH 存在、其余不存在（data:null）', async () => {
    const mock = createMockWindowsInfra()
    await expect(mock.probeEnvVar('PATH')).resolves.toMatchObject({ ok: true })
    await expect(mock.probeEnvVar('NOT_SET_ANYWHERE')).resolves.toEqual({ ok: true, data: null })
    expect(mock.state.envVarNames).toEqual(['PATH', 'NOT_SET_ANYWHERE'])
  })

  it('剪贴板：写入后读回一致；初始为空时读回 null', async () => {
    const mock = createMockWindowsInfra()
    await expect(mock.readClipboard()).resolves.toEqual({ ok: true, data: null })
    await mock.writeClipboard('剪贴板文本')
    await expect(mock.readClipboard()).resolves.toEqual({ ok: true, data: '剪贴板文本' })
  })

  it('Shell 交互：open/notify 记录调用；failShell 折叠为 ok:false', async () => {
    const mock = createMockWindowsInfra()
    await expect(mock.openWithDefault('https://example.com')).resolves.toEqual({ ok: true })
    await expect(mock.notify('标题', '正文')).resolves.toEqual({ ok: true })
    expect(mock.state.openedTargets).toEqual(['https://example.com'])
    expect(mock.state.notifications).toEqual([{ title: '标题', body: '正文' }])

    const failing = createMockWindowsInfra({ failShell: true })
    await expect(failing.writeClipboard('x')).resolves.toMatchObject({ ok: false })
  })
})
