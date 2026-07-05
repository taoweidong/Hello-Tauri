import type { GlobalThemeOverrides } from 'naive-ui'

/** 主题色方案定义 */
export const themeColors = {
  blue: '#3B82F6',
  green: '#10B981',
  purple: '#8B5CF6',
  orange: '#F59E0B',
} as const

export type ThemeColorKey = keyof typeof themeColors

/** Naive UI 主题覆盖 - 与 Tailwind main.css 的 @theme 变量保持同步 */
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
