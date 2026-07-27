/**
 * E2E 场景：主题切换
 * 验证深色/浅色主题切换生效（data-theme 属性变化）
 */
import { test, expect } from '@playwright/test'
import { gotoApp } from './helpers'

test.describe('主题切换', () => {
  test('点击主题按钮切换 data-theme 属性', async ({ page }) => {
    await gotoApp(page)
    const shell = page.locator('[data-theme]').first()
    const initial = await shell.getAttribute('data-theme')
    expect(['dark', 'light']).toContain(initial)

    // 点击顶栏的主题切换按钮（☽/☼ 图标）
    const themeBtn = page.locator('header button').filter({ hasText: /[☽☼]/ })
    await themeBtn.click()
    const toggled = initial === 'dark' ? 'light' : 'dark'
    await expect(shell).toHaveAttribute('data-theme', toggled)

    // 再次点击恢复初始主题
    await themeBtn.click()
    await expect(shell).toHaveAttribute('data-theme', initial!)
  })
})
