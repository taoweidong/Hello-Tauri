/**
 * E2E 场景：面板布局
 * 验证左右侧栏折叠/展开（按钮与键盘快捷键两种方式）
 */
import { test, expect } from '@playwright/test'
import { gotoApp } from './helpers'

test.describe('面板布局', () => {
  test('点击折叠按钮收起/展开左侧面板', async ({ page }) => {
    await gotoApp(page)
    const leftPanel = page.locator('aside').first()
    // 初始展开状态，宽度大于 0
    await expect(page.locator('button[title="收起面板 (Ctrl+B)"]')).toBeVisible()

    // 收起左侧面板（aside 为 box-border 且含 1px 边框，折叠后计算宽度为 1px）
    await page.locator('button[title="收起面板 (Ctrl+B)"]').click()
    await expect(page.locator('button[title="展开面板 (Ctrl+B)"]')).toBeVisible()
    await expect(leftPanel).toHaveCSS('width', /^[01](\.\d+)?px$/)

    // 重新展开
    await page.locator('button[title="展开面板 (Ctrl+B)"]').click()
    await expect(page.locator('button[title="收起面板 (Ctrl+B)"]')).toBeVisible()
    await expect(leftPanel).not.toHaveCSS('width', /^[01](\.\d+)?px$/)
  })

  test('点击折叠按钮收起/展开右侧面板', async ({ page }) => {
    await gotoApp(page)
    const rightPanel = page.locator('aside').nth(1)
    await page.locator('button[title="收起面板 (Ctrl+Shift+B)"]').click()
    await expect(page.locator('button[title="展开面板 (Ctrl+Shift+B)"]')).toBeVisible()
    await expect(rightPanel).toHaveCSS('width', /^[01](\.\d+)?px$/)

    await page.locator('button[title="展开面板 (Ctrl+Shift+B)"]').click()
    await expect(rightPanel).not.toHaveCSS('width', /^[01](\.\d+)?px$/)
  })

  test('Ctrl+B 快捷键切换左侧面板', async ({ page }) => {
    await gotoApp(page)
    const leftPanel = page.locator('aside').first()
    await page.keyboard.press('Control+b')
    await expect(leftPanel).toHaveCSS('width', /^[01](\.\d+)?px$/)
    await page.keyboard.press('Control+b')
    await expect(leftPanel).not.toHaveCSS('width', /^[01](\.\d+)?px$/)
  })
})
