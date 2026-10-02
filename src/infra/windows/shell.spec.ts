import { describe, expect, it, vi } from 'vitest'

import { createShellInteractions, type ShellBridgeDeps } from './shell'

function throwingDeps(): ShellBridgeDeps {
  return {
    shellOpen: vi.fn(() => Promise.reject(new Error('违约异常'))),
    clipboardRead: vi.fn(() => Promise.reject(new Error('违约异常'))),
    clipboardWrite: vi.fn(() => Promise.reject(new Error('违约异常'))),
    notifySend: vi.fn(() => Promise.reject(new Error('违约异常'))),
  }
}

describe('Shell 交互适配器', () => {
  it('正常路径：透传结果并传参', async () => {
    const deps: ShellBridgeDeps = {
      shellOpen: vi.fn(() => Promise.resolve({ ok: true })),
      clipboardRead: vi.fn(async () => ({ ok: true as const, data: '文本' })),
      clipboardWrite: vi.fn(() => Promise.resolve({ ok: true })),
      notifySend: vi.fn(() => Promise.resolve({ ok: true })),
    }
    const shell = createShellInteractions(deps)
    await expect(shell.openWithDefault('https://example.com')).resolves.toEqual({ ok: true })
    await expect(shell.readClipboard()).resolves.toEqual({ ok: true, data: '文本' })
    await expect(shell.writeClipboard('新文本')).resolves.toEqual({ ok: true })
    await expect(shell.notify('标题', '正文')).resolves.toEqual({ ok: true })
    expect(deps.shellOpen).toHaveBeenCalledWith('https://example.com')
    expect(deps.clipboardWrite).toHaveBeenCalledWith('新文本')
    expect(deps.notifySend).toHaveBeenCalledWith('标题', '正文')
  })

  it('失败结果透传：目标不存在 / 剪贴板非文本 / 通知不可用（ok:false 不 reject）', async () => {
    const shell = createShellInteractions({
      shellOpen: () => Promise.resolve({ ok: false, reason: '打开目标不存在：C:\\nope' }),
      clipboardRead: () => Promise.resolve({ ok: true, data: null }),
      clipboardWrite: () => Promise.resolve({ ok: false, reason: '权限被拒' }),
      notifySend: () => Promise.resolve({ ok: false, reason: '通知能力不可用' }),
    })
    await expect(shell.openWithDefault('C:\\nope')).resolves.toMatchObject({ ok: false })
    await expect(shell.readClipboard()).resolves.toEqual({ ok: true, data: null })
    await expect(shell.writeClipboard('x')).resolves.toMatchObject({ ok: false, reason: '权限被拒' })
    await expect(shell.notify('a', 'b')).resolves.toMatchObject({ ok: false, reason: '通知能力不可用' })
  })

  it('永不 reject：Bridge 实现违约抛错时折叠为失败结果（backstop）', async () => {
    const shell = createShellInteractions(throwingDeps())
    const opened = await shell.openWithDefault('anything')
    expect(opened.ok).toBe(false)
    if (!opened.ok) expect(opened.detail).toBe('违约异常')
    await expect(shell.readClipboard()).resolves.toMatchObject({ ok: false })
    await expect(shell.writeClipboard('x')).resolves.toMatchObject({ ok: false })
    await expect(shell.notify('a', 'b')).resolves.toMatchObject({ ok: false })
  })
})
