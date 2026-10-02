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
    const methods = [
      'loadConfig',
      'saveConfig',
      'readTable',
      'writeTable',
      'appendLog',
      'storageInfo',
      'storageMigrate',
      'openStorageDir',
      'fsRead',
      'fsWrite',
      'appInfo',
      'dbExecute',
      'dbSelect',
      'dbTransaction',
      'dbMigrate',
      // M1 通道层：WeLink CLI 外部进程调用（Rust cli_run 的桥接口）
      'cliRun',
      // windows-infra-foundation：系统信息 + Shell 交互（永不 reject 语义）
      'sysOverview',
      'sysEnvVar',
      'sysDisks',
      'sysAdapters',
      'shellOpen',
      'clipboardRead',
      'clipboardWrite',
      'notifySend',
    ] as const
    const { webBridge } = await import('@/api/web')
    const { tauriBridge } = await import('@/api/tauri')
    for (const m of methods) {
      expect(typeof webBridge[m], `web.${m}`).toBe('function')
      expect(typeof tauriBridge[m], `tauri.${m}`).toBe('function')
    }
  })

  it('web 模式系统信息：结构一致且带 [MOCK-WIN] 标注', async () => {
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__
    const { webBridge } = await import('@/api/web')
    const overview = await webBridge.sysOverview()
    expect(overview.ok).toBe(true)
    if (overview.ok) expect(overview.data.osName).toContain('[MOCK-WIN]')
    const disks = await webBridge.sysDisks()
    expect(disks.ok).toBe(true)
    if (disks.ok) expect(disks.data.length).toBeGreaterThan(0)
    const missing = await webBridge.sysEnvVar('SOME_MISSING_VAR')
    expect(missing).toEqual({ ok: true, data: null })
  })

  it('web 模式 shellOpen：仅放行 http/https，其余折叠为失败结果', async () => {
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__
    const { webBridge } = await import('@/api/web')
    const refused = await webBridge.shellOpen('C:\\Windows')
    expect(refused.ok).toBe(false)
    expect(refused.reason).toBeTruthy()
  })

  it('永不 reject 契约：宿主异常折叠为结果对象（web + tauri 两侧）', async () => {
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__
    const { webBridge } = await import('@/api/web')
    // happy-dom 无 Notification → 未送达结果而不是异常
    const notify = await webBridge.notifySend('标题', '正文')
    expect(notify.ok).toBe(false)
    expect(typeof notify.reason).toBe('string')

    ;(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {}
    const { tauriBridge } = await import('@/api/tauri')
    // 测试环境无 Tauri 后端，invoke 必然抛错 —— 折叠为 ok:false 而不是 reject
    const folded = await tauriBridge.sysOverview()
    expect(folded.ok).toBe(false)
    if (!folded.ok) expect(folded.reason).toBe('宿主调用失败')
    const acted = await tauriBridge.notifySend('标题', '正文')
    expect(acted.ok).toBe(false)
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__
  })
})
