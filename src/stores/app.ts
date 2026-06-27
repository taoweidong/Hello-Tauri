import { defineStore } from 'pinia'
import { ref } from 'vue'

export const useAppStore = defineStore('app', () => {
  const isDarkTheme = ref(true)
  const disabledPlugins = ref<string[]>([])
  const leftPanelWidth = ref(280)
  const rightPanelWidth = ref(300)

  function toggleTheme() {
    isDarkTheme.value = !isDarkTheme.value
  }

  function setLeftPanelWidth(w: number) {
    leftPanelWidth.value = Math.max(200, Math.min(400, w))
  }

  function setRightPanelWidth(w: number) {
    rightPanelWidth.value = Math.max(240, Math.min(500, w))
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
