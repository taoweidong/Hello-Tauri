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
import { type ThemeColorKey } from '@/styles/theme'

/** 应用全局状态 Store（Pinia），管理主题、面板布局与插件启停 */
export const useAppStore = defineStore('app', () => {
  /** 是否为暗色主题 */
  const isDarkTheme = ref(true)
  /** 已禁用的插件 id 列表 */
  const disabledPlugins = ref<string[]>([])
  /** 左侧面板宽度（像素） */
  const leftPanelWidth = ref(DEFAULT_LEFT_PANEL_WIDTH)
  /** 右侧面板宽度（像素） */
  const rightPanelWidth = ref(DEFAULT_RIGHT_PANEL_WIDTH)
  /** 当前主题色标识 */
  const themeColor = ref<ThemeColorKey>('blue')

  /** 切换暗色/亮色主题 */
  function toggleTheme() {
    isDarkTheme.value = !isDarkTheme.value
  }

  /**
   * 设置主题色
   * @param color - 主题色标识键
   */
  function setThemeColor(color: ThemeColorKey) {
    themeColor.value = color
  }

  /**
   * 设置左侧面板宽度，自动约束在允许范围内
   * @param w - 目标宽度（像素）
   */
  function setLeftPanelWidth(w: number) {
    leftPanelWidth.value = Math.max(MIN_LEFT_PANEL_WIDTH, Math.min(MAX_LEFT_PANEL_WIDTH, w))
  }

  /**
   * 设置右侧面板宽度，自动约束在允许范围内
   * @param w - 目标宽度（像素）
   */
  function setRightPanelWidth(w: number) {
    rightPanelWidth.value = Math.max(MIN_RIGHT_PANEL_WIDTH, Math.min(MAX_RIGHT_PANEL_WIDTH, w))
  }

  /**
   * 禁用指定插件（加入禁用列表）
   * @param id - 插件唯一标识
   */
  function disablePlugin(id: string) {
    if (!disabledPlugins.value.includes(id)) {
      disabledPlugins.value = [...disabledPlugins.value, id]
    }
  }

  /**
   * 启用指定插件（从禁用列表移除）
   * @param id - 插件唯一标识
   */
  function enablePlugin(id: string) {
    disabledPlugins.value = disabledPlugins.value.filter(p => p !== id)
  }

  /**
   * 判断指定插件是否已被禁用
   * @param id - 插件唯一标识
   * @returns 插件是否处于禁用状态
   */
  function isPluginDisabled(id: string): boolean {
    return disabledPlugins.value.includes(id)
  }

  return {
    isDarkTheme,
    disabledPlugins,
    leftPanelWidth,
    rightPanelWidth,
    themeColor,
    toggleTheme,
    setThemeColor,
    setLeftPanelWidth,
    setRightPanelWidth,
    disablePlugin,
    enablePlugin,
    isPluginDisabled,
  }
})
