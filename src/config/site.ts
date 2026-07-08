/**
 * 站点核心配置
 * 集中管理应用名称、链接、Logo 等全局常量，避免散弹式修改
 */

/** 应用名称 */
export const APP_NAME = 'Hello Tauri'

/** 副标题（导航栏徽章） */
export const APP_BADGE = '桌面工具'

/** 欢迎页描述 */
export const APP_DESCRIPTION = '跨平台桌面数据工具'

/** 页面标题（index.html / tauri 窗口） */
export const PAGE_TITLE = APP_NAME

/** 外部链接 */
export const SITE_LINKS = {
  github: 'https://github.com/taoweidong/Hello-Tauri',
  issue: 'https://github.com/taoweidong/Hello-Tauri/issues/new',
} as const

/** IndexedDB 数据库名 */
export const DB_NAME = 'hello-tauri-cache'
