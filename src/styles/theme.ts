import type { GlobalThemeOverrides } from 'naive-ui'

/** 主题色方案定义 */
export const themeColors = {
  blue: '#3B82F6',
  green: '#10B981',
  purple: '#8B5CF6',
  orange: '#F59E0B',
} as const

/**
 * 主题色方案类型键
 * 可用于引用预定义的主题色标识
 */
export type ThemeColorKey = keyof typeof themeColors

/**
 * Naive UI 全局主题覆盖配置
 * 定义主色、语义色、字体族与圆角等通用视觉令牌
 */
export const themeOverrides: GlobalThemeOverrides = {
  common: {
    primaryColor: themeColors.blue,
    errorColor: '#EF4444',
    warningColor: '#F59E0B',
    successColor: '#10B981',
    fontFamily: 'system-ui, -apple-system, sans-serif',
    fontFamilyMono: '"JetBrains Mono", "Fira Code", monospace',
    borderRadius: '6px',
    borderRadiusSmall: '4px',
  }
}
