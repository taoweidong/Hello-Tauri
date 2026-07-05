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
export const PAGE_TITLE = '日志解析工具'

/** 外部链接 */
export const SITE_LINKS = {
  github: 'https://github.com/taoweidong/Hello-Tauri',
  issue: 'https://github.com/taoweidong/Hello-Tauri/issues/new',
} as const

/** IndexedDB 数据库名 */
export const DB_NAME = 'hello-tauri-cache'

/**
 * 科技感内联 Logo SVG（导航栏 & 欢迎页共用）
 * 设计：六边形 + 电路节点 + 数据流线，霓虹蓝紫配色
 */
export const APP_LOGO_SVG = `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
  <path d="M12 2L3.5 6.5V17.5L12 22L20.5 17.5V6.5L12 2Z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/>
  <path d="M12 2V22" stroke="currentColor" stroke-width="0.6" opacity="0.3"/>
  <path d="M3.5 6.5L20.5 17.5" stroke="currentColor" stroke-width="0.6" opacity="0.3"/>
  <path d="M20.5 6.5L3.5 17.5" stroke="currentColor" stroke-width="0.6" opacity="0.3"/>
  <circle cx="12" cy="12" r="3" stroke="currentColor" stroke-width="1.2"/>
  <circle cx="12" cy="12" r="1" fill="currentColor"/>
  <circle cx="12" cy="5" r="0.8" fill="currentColor" opacity="0.7"/>
  <circle cx="12" cy="19" r="0.8" fill="currentColor" opacity="0.7"/>
  <circle cx="6" cy="8.5" r="0.8" fill="currentColor" opacity="0.7"/>
  <circle cx="18" cy="8.5" r="0.8" fill="currentColor" opacity="0.7"/>
  <circle cx="6" cy="15.5" r="0.8" fill="currentColor" opacity="0.7"/>
  <circle cx="18" cy="15.5" r="0.8" fill="currentColor" opacity="0.7"/>
  <path d="M12 5L12 9" stroke="currentColor" stroke-width="0.8" opacity="0.5"/>
  <path d="M12 15L12 19" stroke="currentColor" stroke-width="0.8" opacity="0.5"/>
  <path d="M6.8 9L9.6 10.8" stroke="currentColor" stroke-width="0.8" opacity="0.5"/>
  <path d="M14.4 13.2L17.2 15" stroke="currentColor" stroke-width="0.8" opacity="0.5"/>
  <path d="M17.2 9L14.4 10.8" stroke="currentColor" stroke-width="0.8" opacity="0.5"/>
  <path d="M9.6 13.2L6.8 15" stroke="currentColor" stroke-width="0.8" opacity="0.5"/>
</svg>`
