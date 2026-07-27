/**
 * E2E 场景：应用启动
 * 验证页面加载、标题正确、四栏布局完整
 */
import { test, expect } from '@playwright/test'
import { gotoApp } from './helpers'

test.describe('应用启动', () => {
  test('页面标题与 PAGE_TITLE 一致', async ({ page }) => {
    await gotoApp(page)
    await expect(page).toHaveTitle('Hello Tauri')
  })

  test('顶部导航栏展示应用名与徽章', async ({ page }) => {
    await gotoApp(page)
    const header = page.locator('header')
    await expect(header).toContainText('Hello Tauri')
    await expect(header).toContainText('桌面工具')
  })

  test('四栏布局完整：导航栏、左右面板、工作区、状态栏', async ({ page }) => {
    await gotoApp(page)
    // 左侧归档面板与右侧属性面板
    await expect(page.locator('aside')).toHaveCount(2)
    // 中央工作区默认显示欢迎页引导
    await expect(page.locator('main')).toContainText('拖放文件')
    await expect(page.locator('main')).toContainText('上传文件')
    await expect(page.locator('main')).toContainText('搜索内容')
    // 底部状态栏
    await expect(page.locator('footer')).toBeVisible()
  })
})
