import { describe, it, expect } from 'vitest'
import * as config from '@/config'

describe('config/index.ts 桶导出', () => {
  it('导出 layout 面板宽度常量', () => {
    expect(config.DEFAULT_LEFT_PANEL_WIDTH).toBe(280)
    expect(config.DEFAULT_RIGHT_PANEL_WIDTH).toBe(300)
    expect(config.MIN_LEFT_PANEL_WIDTH).toBe(200)
    expect(config.MAX_LEFT_PANEL_WIDTH).toBe(400)
  })

  it('导出键盘快捷键配置', () => {
    expect(config.KEYBOARD_SHORTCUTS).toBeDefined()
    expect(config.KEYBOARD_SHORTCUTS.search).toBe('Ctrl+K')
  })

  it('导出 site 站点配置', () => {
    expect(config.APP_NAME).toBe('Hello Tauri')
    expect(config.PAGE_TITLE).toBe('日志解析工具')
    expect(config.SITE_LINKS.github).toContain('Hello-Tauri')
  })
})
