import { beforeEach, describe, expect, it, vi } from 'vitest'

import { webBridge } from '@/api/web'

/** web 侧桥接的契约测试：与 tauri 侧保持同样的语义，浏览器模式一切行为可回归 */
describe('webBridge 契约', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('platform 为 web', () => {
    expect(webBridge.platform).toBe('web')
  })

  it('config 读写经 localStorage 往返', async () => {
    expect(await webBridge.loadConfig()).toBeNull()
    await webBridge.saveConfig('{"theme":"dark"}')
    expect(await webBridge.loadConfig()).toBe('{"theme":"dark"}')
  })

  it('table 读写经 localStorage 往返', async () => {
    expect(await webBridge.readTable()).toBeNull()
    await webBridge.writeTable('[{"id":1}]')
    expect(await webBridge.readTable()).toBe('[{"id":1}]')
  })

  it('config 与 table 使用不同键，互不覆盖', async () => {
    await webBridge.saveConfig('cfg')
    await webBridge.writeTable('tbl')
    expect(await webBridge.loadConfig()).toBe('cfg')
    expect(await webBridge.readTable()).toBe('tbl')
  })

  it('appendLog 返回按天命名的日志路径且从不 reject', async () => {
    const path = await webBridge.appendLog('info', 'hello')
    expect(path).toMatch(/^memory:\/\/hello-tauri\/logs\/app-\d{4}-\d{2}-\d{2}\.log$/)
  })

  it('storageInfo 报告降级（内存模式）且带说明', async () => {
    const info = await webBridge.storageInfo()
    expect(info.fallback).toBe(true)
    expect(info.note).toContain('D:\\TangYuan')
    expect(info.preferredRoot).toBe('D:\\TangYuan')
  })

  it('openStorageDir 在浏览器模式明确报错而非静默', async () => {
    await expect(webBridge.openStorageDir()).rejects.toThrow(/浏览器/)
  })

  it('httpPostJson 在浏览器模式明确报错（业务路径不会走到：agent 工厂 web 强制 mock）', async () => {
    await expect(webBridge.httpPostJson('https://llm.example.internal/v1', {}, '{}', 1000)).rejects.toThrow(
      /浏览器.*mock/,
    )
  })

  it('appInfo 提供完整 AppInfo 形状', async () => {
    const info = await webBridge.appInfo()
    expect(info).toMatchObject({
      name: 'Hello-Tauri',
      platform: 'web',
    })
    expect(typeof info.version).toBe('string')
    expect(info.storage).toBeDefined()
  })

  // —— 服务常驻通道（service-residency T-M：浏览器模式完整不受影响）——

  it('onHostEvent 恒 no-op：返回可安全调用的退订函数', async () => {
    const handler = vi.fn()
    const unlisten = await webBridge.onHostEvent('host://tray-toggle', handler)
    expect(typeof unlisten).toBe('function')
    expect(() => unlisten()).not.toThrow()
    unlisten()
  })

  it('traySetStatus / traySetClosePolicy 为无副作用的诚实 no-op', async () => {
    await expect(webBridge.traySetStatus(true, '服务运行中')).resolves.toEqual({ ok: true })
    await expect(webBridge.traySetClosePolicy('tray')).resolves.toEqual({ ok: true })
  })

  it('autostart 在浏览器模式诚实拒绝（不假装可用）', async () => {
    await expect(webBridge.autostartGet()).resolves.toMatchObject({ ok: false, reason: expect.any(String) })
    await expect(webBridge.autostartSet(true)).resolves.toMatchObject({ ok: false, reason: expect.any(String) })
  })

  // —— 更新通道（design-auto-update U-L：浏览器业务路径由 infra/update mock 承担，
  //    Bridge 侧诚实报错/折叠，两侧契约对称）——

  it('httpGetText / updateDownload 在浏览器模式明确报错（业务路径不会走到）', async () => {
    await expect(webBridge.httpGetText('http://x/latest.json', {}, 1000)).rejects.toThrow(/浏览器/)
    await expect(webBridge.updateDownload('http://x/app.exe', 'update/staging/a.exe', undefined)).rejects.toThrow(
      /浏览器/,
    )
  })

  it('verifyMinisign / updateApply 永不 reject：折叠为否定结果', async () => {
    await expect(webBridge.verifyMinisign('m', 's', 'k')).resolves.toMatchObject({
      valid: false,
      reason: expect.stringContaining('mock'),
    })
    const outcome = await webBridge.updateApply('update/staging/a.exe')
    expect(outcome.ok).toBe(false)
    expect(outcome.reason).toContain('mock')
  })

  it('onDownloadProgress 恒 no-op：返回可安全调用的退订函数', async () => {
    const unlisten = await webBridge.onDownloadProgress(() => {})
    expect(typeof unlisten).toBe('function')
    expect(() => unlisten()).not.toThrow()
    unlisten()
  })
})
