import { describe, expect, it, vi } from 'vitest'

/**
 * 运行时探测：有 __TAURI_INTERNALS__ 选 tauri 实现，否则 web 实现。
 * 模块在 import 期做判定，因此用 resetModules 重导。
 */
async function reloadBridge() {
  vi.resetModules()
  const mod = await import('@/api')
  return mod
}

describe('bridge 运行时选择', () => {
  it('无 Tauri 注入环境 → webBridge', async () => {
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__
    const { bridge, platform } = await reloadBridge()
    expect(platform).toBe('web')
    expect(bridge.loadConfig).toBeTypeOf('function')
  })

  it('存在 __TAURI_INTERNALS__ → tauriBridge', async () => {
    ;(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {}
    const { bridge, platform } = await reloadBridge()
    expect(platform).toBe('tauri')
    expect(bridge.platform).toBe('tauri')
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__
  })

  it('两侧契约方法名完全一致（Bridge 接口对齐）', async () => {
    const methods = ['loadConfig', 'saveConfig', 'readTable', 'writeTable', 'appendLog', 'storageInfo', 'openStorageDir', 'appInfo'] as const
    const { webBridge } = await import('@/api/web')
    const { tauriBridge } = await import('@/api/tauri')
    for (const m of methods) {
      expect(typeof webBridge[m], `web.${m}`).toBe('function')
      expect(typeof tauriBridge[m], `tauri.${m}`).toBe('function')
    }
  })
})