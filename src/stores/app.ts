import { defineStore } from 'pinia'
import { ref } from 'vue'
import {
  DEFAULT_LEFT_PANEL_WIDTH,
  DEFAULT_RIGHT_PANEL_WIDTH,
  MIN_LEFT_PANEL_WIDTH,
  MAX_LEFT_PANEL_WIDTH,
  MIN_RIGHT_PANEL_WIDTH,
  MAX_RIGHT_PANEL_WIDTH,
} from '@/config'

export const useAppStore = defineStore('app', () => {
  const isDarkTheme = ref(true)
  const disabledPlugins = ref<string[]>([])
  const leftPanelWidth = ref(DEFAULT_LEFT_PANEL_WIDTH)
  const rightPanelWidth = ref(DEFAULT_RIGHT_PANEL_WIDTH)

  function toggleTheme() {
    isDarkTheme.value = !isDarkTheme.value
  }

  function setLeftPanelWidth(w: number) {
    leftPanelWidth.value = Math.max(MIN_LEFT_PANEL_WIDTH, Math.min(MAX_LEFT_PANEL_WIDTH, w))
  }

  function setRightPanelWidth(w: number) {
    rightPanelWidth.value = Math.max(MIN_RIGHT_PANEL_WIDTH, Math.min(MAX_RIGHT_PANEL_WIDTH, w))
  }

  function disablePlugin(id: string) {
    if (!disabledPlugins.value.includes(id)) {
      disabledPlugins.value = [...disabledPlugins.value, id]
    }
  }

  function enablePlugin(id: string) {
    disabledPlugins.value = disabledPlugins.value.filter(p => p !== id)
  }

  function isPluginDisabled(id: string): boolean {
    return disabledPlugins.value.includes(id)
  }

  return {
    isDarkTheme,
    disabledPlugins,
    leftPanelWidth,
    rightPanelWidth,
    toggleTheme,
    setLeftPanelWidth,
    setRightPanelWidth,
    disablePlugin,
    enablePlugin,
    isPluginDisabled,
  }
})
