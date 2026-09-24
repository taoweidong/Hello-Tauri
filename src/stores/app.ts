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
      }
      const [appInfo, layout] = await Promise.all([bridge.appInfo(), bridge.storageInfo()])
      info.value = appInfo
      storage.value = layout
      logger.info(
        layout.fallback
          ? `应用启动（存储降级）：${layout.note}`
          : `应用启动，数据目录 ${layout.root}`,
      )
    } catch (error) {
      logger.error('初始化失败，使用默认配置', error)
    }
    applyTheme()
    ready.value = true
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
    load,
    save,
    reset,
  }
})