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
