import { defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'

import { bridge } from '@/api'
import type { AppInfo, AppSettings, StorageLayout } from '@/types'
import { logger } from '@/utils/logger'

const DEFAULT_SETTINGS: AppSettings = {
  title: 'Hello-Tauri',
  description: 'Tauri 2 + Vue 3 单文件桌面应用模板',
  theme: 'light',
  pageSize: 10,
  autoSave: true,
  sidebarCollapsed: false,
  defaultRoute: '/',
}

export const useAppStore = defineStore('app', () => {
  const settings = ref<AppSettings>({ ...DEFAULT_SETTINGS })
  const info = ref<AppInfo | null>(null)
  const storage = ref<StorageLayout | null>(null)
  const ready = ref(false)
  const saving = ref(false)
  const lastSavedAt = ref<number | null>(null)

  /**
   * 开机自启开关（service-residency T-I）：宿主注册表态，**不是** config 态 ——
   * 不进 settings（避免与注册表双真值漂移），真值以 `bridge.autostartGet` 回显为准。
   */
  const autostart = ref(false)

  /** 存储位置降级提示：非空时界面需要显式告知用户 */
  const storageWarning = computed(() => (storage.value?.fallback ? storage.value.note : ''))

  function applyTheme() {
    document.documentElement.classList.toggle('dark', settings.value.theme === 'dark')
  }

  async function load() {
    try {
      const raw = await bridge.loadConfig()
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<AppSettings>
        settings.value = { ...DEFAULT_SETTINGS, ...parsed }
      } else {
        // 首次启动（配置文件尚不存在）：把默认值立即落盘。
        // 否则用户装完程序在配置目录里看不到任何配置文件，无法手工调整系统配置。
        await save()
        logger.info('首次启动，已写入默认配置')
      }
      const [appInfo, layout] = await Promise.all([bridge.appInfo(), bridge.storageInfo()])
      info.value = appInfo
      storage.value = layout
      logger.info(layout.fallback ? `应用启动（存储降级）：${layout.note}` : `应用启动，数据目录 ${layout.root}`)
      // 自启开关回显（T-I）：真值在注册表，load 成功后顺带读取；失败静默保持 false
      void loadAutostart()
    } catch (error) {
      logger.error('初始化失败，使用默认配置', error)
    }
    applyTheme()
    ready.value = true
  }

  /** 读注册表 Run 项回显自启开关（ProbeResult 语义：失败保持现状，永不 reject） */
  async function loadAutostart(): Promise<void> {
    const result = await bridge.autostartGet()
    if (result.ok) autostart.value = result.data === true
  }

  /**
   * 设置开机自启。失败**回滚开关并返回 false**（永不假设成功），错误已落日志，
   * 调用方（设置页）负责给出可见反馈。
   */
  async function setAutostart(enabled: boolean): Promise<boolean> {
    const result = await bridge.autostartSet(enabled)
    if (!result.ok) {
      autostart.value = !enabled
      logger.error(`开机自启设置失败：${result.reason}${result.detail ? `（${result.detail}）` : ''}`)
      return false
    }
    autostart.value = enabled
    return true
  }

  async function save(): Promise<boolean> {
    saving.value = true
    try {
      await bridge.saveConfig(JSON.stringify(settings.value, null, 2))
      lastSavedAt.value = Date.now()
      return true
    } catch (error) {
      logger.error('保存配置失败', error)
      return false
    } finally {
      saving.value = false
    }
  }

  function reset() {
    settings.value = { ...DEFAULT_SETTINGS }
  }

  watch(
    settings,
    () => {
      applyTheme()
      if (ready.value && settings.value.autoSave) {
        void save()
      }
    },
    { deep: true },
  )

  return {
    settings,
    info,
    storage,
    storageWarning,
    ready,
    saving,
    lastSavedAt,
    /** 开机自启开关（宿主注册表态，不随 config.json 持久化，T-I） */
    autostart,
    load,
    save,
    reset,
    setAutostart,
  }
})
