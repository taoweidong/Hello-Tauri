import { defineStore } from 'pinia'
import { ref, watch } from 'vue'

import { bridge } from '@/api'
import type { AppInfo, AppSettings } from '@/types'

const DEFAULT_SETTINGS: AppSettings = {
  theme: 'light',
  pageSize: 10,
  autoSave: true,
  sidebarCollapsed: false,
  defaultRoute: '/',
}

export const useAppStore = defineStore('app', () => {
  const settings = ref<AppSettings>({ ...DEFAULT_SETTINGS })
  const info = ref<AppInfo | null>(null)
  const ready = ref(false)
  const saving = ref(false)
  const lastSavedAt = ref<number | null>(null)

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
      info.value = await bridge.appInfo()
    } catch (error) {
      console.error('[app] 初始化失败，使用默认配置', error)
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
      console.error('[app] 保存配置失败', error)
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

  return { settings, info, ready, saving, lastSavedAt, load, save, reset }
})
