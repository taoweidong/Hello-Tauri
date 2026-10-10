import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * tauriBridge 服务常驻通道的契约测试（service-residency §10.3）。
 *
 * 桌面实现把「永不 reject」契约落实在 onHostEvent/traySetStatus/autostart* 上：
 * 注册通道故障折叠为空退订、宿主异常折叠为结果对象。这里用假 listen/invoke
 * 驱动，逐条钉住 —— 真实 Tauri 后端在单测环境不可用（见 index.spec 的折叠测试）。
 */

const { invokeMock, listenMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  listenMock: vi.fn(),
}))

vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))
vi.mock('@tauri-apps/api/event', () => ({ listen: listenMock }))

import { tauriBridge } from '@/api/tauri'

describe('tauriBridge：onHostEvent', () => {
  beforeEach(() => {
    invokeMock.mockReset()
    listenMock.mockReset()
  })

  it('注册：listen 收到事件名与处理器；退订函数透传', async () => {
    const unlisten = vi.fn()
    listenMock.mockResolvedValue(unlisten)
    const handler = vi.fn()
    const dispose = await tauriBridge.onHostEvent('host://tray-toggle', handler)

    expect(listenMock).toHaveBeenCalledTimes(1)
    expect(listenMock.mock.calls[0][0]).toBe('host://tray-toggle')

    // 事件到达 → handler 被调
    listenMock.mock.calls[0][1]()
    expect(handler).toHaveBeenCalledTimes(1)

    dispose()
    expect(unlisten).toHaveBeenCalledTimes(1)
  })

  it('listen 注册故障 → 折叠为空退订（永不 reject）', async () => {
    listenMock.mockRejectedValue(new Error('channel broken'))
    const dispose = await tauriBridge.onHostEvent('host://window-shown', () => {})
    expect(() => dispose()).not.toThrow()
  })
})

describe('tauriBridge：托盘显示回写与策略下发', () => {
  beforeEach(() => {
    invokeMock.mockReset()
    listenMock.mockReset()
  })

  it('traySetStatus：命令名与参数原样透传', async () => {
    invokeMock.mockResolvedValue(null)
    await expect(tauriBridge.traySetStatus(true, '服务运行中')).resolves.toEqual({ ok: true })
    expect(invokeMock).toHaveBeenCalledWith('tray_set_status', { running: true, statusText: '服务运行中' })
  })

  it('traySetClosePolicy：策略串原样透传', async () => {
    invokeMock.mockResolvedValue(null)
    await expect(tauriBridge.traySetClosePolicy('quit')).resolves.toEqual({ ok: true })
    expect(invokeMock).toHaveBeenCalledWith('tray_set_close_policy', { policy: 'quit' })
  })

  it('宿主异常折叠为结果对象（永不 reject 契约）', async () => {
    invokeMock.mockRejectedValue(new Error('托盘未就绪'))
    const outcome = await tauriBridge.traySetStatus(false, '服务已停止')
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.reason).toBe('宿主调用失败')
      expect(outcome.detail).toContain('托盘未就绪')
    }
  })
})

describe('tauriBridge：开机自启', () => {
  beforeEach(() => {
    invokeMock.mockReset()
    listenMock.mockReset()
  })

  it('autostartGet/Set：成功带 data，失败折叠 ProbeResult', async () => {
    invokeMock.mockResolvedValueOnce(true)
    await expect(tauriBridge.autostartGet()).resolves.toEqual({ ok: true, data: true })
    expect(invokeMock).toHaveBeenCalledWith('autostart_get')

    invokeMock.mockRejectedValueOnce(new Error('注册表读取失败'))
    const failed = await tauriBridge.autostartGet()
    expect(failed.ok).toBe(false)
    if (!failed.ok) expect(failed.detail).toContain('注册表读取失败')

    invokeMock.mockResolvedValueOnce(true)
    await expect(tauriBridge.autostartSet(true)).resolves.toEqual({ ok: true, data: true })
    expect(invokeMock).toHaveBeenCalledWith('autostart_set', { enabled: true })
  })
})

// —— 自动更新通道（design-auto-update §10.3：契约与 Rust update.rs 一致）——

describe('tauriBridge：更新通道（命令透传）', () => {
  beforeEach(() => {
    invokeMock.mockReset()
    listenMock.mockReset()
  })

  it('httpGetText：headers 以二元组数组透传（同 httpPostJson 惯例）', async () => {
    invokeMock.mockResolvedValue({ status: 200, body: '{}' })
    await tauriBridge.httpGetText('http://x/latest.json', { accept: 'application/json' }, 5000)
    expect(invokeMock).toHaveBeenCalledWith('http_get_text', {
      url: 'http://x/latest.json',
      headers: [['accept', 'application/json']],
      timeoutMs: 5000,
    })
  })

  it('updateDownload：dest/timeout/expected sha 原样透传', async () => {
    invokeMock.mockResolvedValue({ bytes: 1, sha256: 'a'.repeat(64) })
    await tauriBridge.updateDownload('http://x/app.exe', 'update/staging/app-0.2.0.exe', undefined, 'A'.repeat(64))
    expect(invokeMock).toHaveBeenCalledWith('update_download', {
      url: 'http://x/app.exe',
      destRelative: 'update/staging/app-0.2.0.exe',
      timeoutMs: undefined,
      expectedSha256: 'A'.repeat(64),
    })
  })

  it('verifyMinisign / updateApply：参数透传', async () => {
    invokeMock.mockResolvedValue({ valid: true, reason: '' })
    await tauriBridge.verifyMinisign('manifest', 'sig', 'PUBKEY')
    expect(invokeMock).toHaveBeenCalledWith('verify_minisign', { message: 'manifest', signature: 'sig', publicKey: 'PUBKEY' })

    invokeMock.mockResolvedValue({ ok: true, step: null, rolledBack: false, reason: null })
    await tauriBridge.updateApply('update/staging/app-0.2.0.exe', 'a'.repeat(64))
    expect(invokeMock).toHaveBeenCalledWith('update_apply', {
      stagedRelative: 'update/staging/app-0.2.0.exe',
      expectedSha256: 'a'.repeat(64),
    })
  })
})

describe('tauriBridge：更新通道（永不 reject 折叠契约）', () => {
  beforeEach(() => {
    invokeMock.mockReset()
    listenMock.mockReset()
  })

  it('verifyMinisign：宿主 Err 折叠为 valid:false（公钥失败与验签失败对业务等价）', async () => {
    invokeMock.mockRejectedValue('公钥解析失败: bad key')
    await expect(tauriBridge.verifyMinisign('m', 's', 'k')).resolves.toMatchObject({
      valid: false,
      reason: expect.stringContaining('验签通道故障'),
    })
  })

  it('updateApply：宿主 Err / IPC 故障折叠为 ok:false（不向调用方 reject）', async () => {
    invokeMock.mockRejectedValue(new Error('invoke crashed'))
    const outcome = await tauriBridge.updateApply('x')
    expect(outcome.ok).toBe(false)
    expect(outcome.reason).toContain('自替换通道故障')
  })

  it('onDownloadProgress：注册 update://progress、载荷透传、退订函数透传', async () => {
    const unlisten = vi.fn()
    listenMock.mockResolvedValue(unlisten)
    const received: Array<unknown> = []
    const dispose = await tauriBridge.onDownloadProgress((progress) => received.push(progress))

    expect(listenMock).toHaveBeenCalledWith('update://progress', expect.any(Function))
    listenMock.mock.calls[0][1]({ payload: { received: 10, total: 100 } })
    expect(received).toEqual([{ received: 10, total: 100 }])

    dispose()
    expect(unlisten).toHaveBeenCalledTimes(1)
  })

  it('onDownloadProgress：注册故障折叠为空退订（永不 reject）', async () => {
    listenMock.mockRejectedValue(new Error('channel broken'))
    const dispose = await tauriBridge.onDownloadProgress(() => {})
    expect(() => dispose()).not.toThrow()
  })
})
