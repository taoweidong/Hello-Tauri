import { beforeEach, describe, expect, it } from 'vitest'

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

  it('appInfo 提供完整 AppInfo 形状', async () => {
    const info = await webBridge.appInfo()
    expect(info).toMatchObject({
      name: 'Hello-Tauri',
      platform: 'web',
    })
    expect(typeof info.version).toBe('string')
    expect(info.storage).toBeDefined()
  })
})