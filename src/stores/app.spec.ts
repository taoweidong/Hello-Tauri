import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

import type { AppSettings, ProbeResult } from '@/types'

/**
 * app store 测试：配置初始化与落盘语义。
 *
 * 重点是「首次启动」分支 —— 配置文件不存在时必须把默认值写出去。
 * 否则用户装完程序在数据目录里看不到任何配置文件，无法手工调整系统配置
 * （这个缺陷由服务启动冒烟测试 smoke.mjs 暴露，此处加单测防回退）。
 */

const { bridgeMock, storage } = vi.hoisted(() => ({
  bridgeMock: {
    loadConfig: vi.fn<() => Promise<string | null>>(),
    saveConfig: vi.fn<(content: string) => Promise<void>>(),
    // 自启态（service-residency T-I）：默认不可用（测试桩不模拟注册表），
    // 自启开关用例在各自 describe 里按需改写实现
    autostartGet: vi.fn<() => Promise<ProbeResult<boolean>>>(async () => ({
      ok: false,
      reason: '测试桩不提供自启态',
    })),
    autostartSet: vi.fn<(enabled: boolean) => Promise<ProbeResult<boolean>>>(async () => ({
      ok: false,
      reason: '测试桩不提供自启态',
    })),
    appInfo: vi.fn(async () => ({
      name: 'Hello-Tauri',
      version: '0.1.0',
      platform: 'tauri' as const,
      dataDir: 'D:\\TangYuan',
    })),
    storageInfo: vi.fn(async () => ({
      root: 'D:\\TangYuan',
      preferredRoot: 'D:\\TangYuan',
      configFile: 'D:\\TangYuan\\config\\config.json',
      tableFile: 'D:\\TangYuan\\data\\table.json',
      dbFile: 'D:\\TangYuan\\data\\app.db',
      logsDir: 'D:\\TangYuan\\logs',
      fallback: false,
      note: '',
    })),
  },
  storage: {
    saved: [] as string[],
  },
}))

vi.mock('@/api', () => ({ bridge: bridgeMock, platform: 'tauri' }))
vi.mock('@/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

/** 每次 import 都拿到全新的 store 实例（模块级 defineStore 有缓存） */
async function freshStore() {
  vi.resetModules()
  const { useAppStore } = await import('@/stores/app')
  return useAppStore()
}

const REQUIRED_KEYS: (keyof AppSettings)[] = [
  'title',
  'description',
  'theme',
  'pageSize',
  'autoSave',
  'sidebarCollapsed',
  'defaultRoute',
]

describe('app store · 配置初始化', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    storage.saved = []
    bridgeMock.loadConfig.mockReset()
    bridgeMock.saveConfig.mockReset()
    bridgeMock.saveConfig.mockImplementation(async (content: string) => {
      storage.saved.push(content)
    })
  })

  it('首次启动（配置文件不存在）→ 立即落盘默认配置', async () => {
    bridgeMock.loadConfig.mockResolvedValue(null)

    const store = await freshStore()
    await store.load()

    expect(bridgeMock.saveConfig).toHaveBeenCalledTimes(1)
    const written = JSON.parse(storage.saved[0]) as AppSettings
    for (const key of REQUIRED_KEYS) {
      expect(written, `缺少配置项 ${key}`).toHaveProperty(key)
    }
    expect(store.ready).toBe(true)
  })

  it('落盘内容与内存中的设置完全一致', async () => {
    bridgeMock.loadConfig.mockResolvedValue(null)

    const store = await freshStore()
    await store.load()

    expect(JSON.parse(storage.saved[0])).toEqual(store.settings)
  })

  it('已有完整配置 → 不产生多余回写', async () => {
    const existing: AppSettings = {
      title: '我的工作台',
      description: '自定义描述',
      theme: 'dark',
      pageSize: 20,
      autoSave: false,
      sidebarCollapsed: true,
      defaultRoute: '/table',
    }
    bridgeMock.loadConfig.mockResolvedValue(JSON.stringify(existing))

    const store = await freshStore()
    await store.load()

    expect(store.settings).toEqual(existing)
    // autoSave=false，因此 watcher 不应触发保存
    expect(bridgeMock.saveConfig).not.toHaveBeenCalled()
  })

  it('旧配置缺字段 → 用默认值补齐（不丢用户已有项）', async () => {
    bridgeMock.loadConfig.mockResolvedValue(JSON.stringify({ title: '老配置', pageSize: 50 }))

    const store = await freshStore()
    await store.load()

    expect(store.settings.title).toBe('老配置')
    expect(store.settings.pageSize).toBe(50)
    for (const key of REQUIRED_KEYS) {
      expect(store.settings, `缺少配置项 ${key}`).toHaveProperty(key)
    }
  })

  it('配置文件损坏（非 JSON）→ 不崩溃，走默认值', async () => {
    bridgeMock.loadConfig.mockResolvedValue('{ 这不是 JSON')

    const store = await freshStore()
    await store.load()

    expect(store.ready).toBe(true)
    expect(store.settings.pageSize).toBe(10)
  })
})

describe('app store · 开机自启开关（service-residency T-I）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    storage.saved = []
    bridgeMock.loadConfig.mockReset()
    bridgeMock.saveConfig.mockReset()
    bridgeMock.autostartGet.mockReset()
    bridgeMock.autostartGet.mockResolvedValue({ ok: false, reason: '测试桩不提供自启态' })
    bridgeMock.autostartSet.mockReset()
    bridgeMock.autostartSet.mockResolvedValue({ ok: false, reason: '测试桩不提供自启态' })
    bridgeMock.saveConfig.mockImplementation(async (content: string) => {
      storage.saved.push(content)
    })
  })

  it('load：宿主回显 ok:true → autostart 跟随注册表态', async () => {
    bridgeMock.loadConfig.mockResolvedValue(null)
    bridgeMock.autostartGet.mockResolvedValue({ ok: true, data: true })

    const store = await freshStore()
    await store.load()
    // loadAutostart 在 load() 内是 void 调用：flush 微任务让回显落地
    await Promise.resolve()
    await Promise.resolve()

    expect(store.autostart).toBe(true)
  })

  it('setAutostart：宿主失败 → 开关回滚 + 返回 false（永不假设成功）', async () => {
    bridgeMock.loadConfig.mockResolvedValue(null)
    bridgeMock.autostartSet.mockResolvedValue({ ok: false, reason: '打开 Run 注册表项失败（os error 5）' })

    const store = await freshStore()
    await store.load()

    await expect(store.setAutostart(true)).resolves.toBe(false)
    expect(store.autostart).toBe(false) // 回滚，不残留假开关
    // 真值在注册表、不入 config.json：自启操作不触发配置落盘
    // （load 首启分支本身有一次落盘，对比差值而非绝对次数）
    const savesAfterLoad = bridgeMock.saveConfig.mock.calls.length
    await store.setAutostart(false)
    expect(bridgeMock.saveConfig.mock.calls.length).toBe(savesAfterLoad)
  })

  it('setAutostart：宿主成功 → 开关跟随目标态', async () => {
    bridgeMock.loadConfig.mockResolvedValue(null)
    bridgeMock.autostartSet.mockImplementation(async (enabled: boolean) => ({ ok: true, data: enabled }))

    const store = await freshStore()
    await store.load()

    await expect(store.setAutostart(true)).resolves.toBe(true)
    expect(store.autostart).toBe(true)
    expect(bridgeMock.autostartSet).toHaveBeenCalledWith(true)
  })
})
