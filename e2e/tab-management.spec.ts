/**
 * E2E 场景：标签页管理
 * 验证打开/切换/关闭标签页与欢迎页回退
 */
import { test, expect } from '@playwright/test'
import { gotoApp, uploadAndWaitCompleted, openFileFromTree } from './helpers'

test.describe('标签页管理', () => {
  test('打开多个文件生成多个标签页，最后打开的处于激活态', async ({ page }) => {
    await gotoApp(page)
    const card = await uploadAndWaitCompleted(page, 'data.zip')
    await openFileFromTree(page, card, 'sample.txt')
    await openFileFromTree(page, card, 'sample.csv')
    await expect(page.locator('.tab-item')).toHaveCount(2)
    await expect(page.locator('.tab-item.tab-active')).toContainText('sample.csv')
  })

  test('点击标签页可切换激活状态', async ({ page }) => {
    await gotoApp(page)
    const card = await uploadAndWaitCompleted(page, 'data.zip')
    await openFileFromTree(page, card, 'sample.txt')
    await openFileFromTree(page, card, 'sample.csv')
    // 切回第一个标签
    await page.locator('.tab-item').filter({ hasText: 'sample.txt' }).click()
    await expect(page.locator('.tab-item.tab-active')).toContainText('sample.txt')
  })

  test('关闭全部标签页后回到欢迎页', async ({ page }) => {
    await gotoApp(page)
    const card = await uploadAndWaitCompleted(page, 'data.zip')
    await openFileFromTree(page, card, 'sample.txt')
    // 点击标签上的关闭按钮
    await page.locator('.tab-item').filter({ hasText: 'sample.txt' }).locator('.tab-close-btn').click()
    await expect(page.locator('.tab-item')).toHaveCount(0)
    // 欢迎页重新出现
    await expect(page.locator('main')).toContainText('拖放文件')
  })
})
