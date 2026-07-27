/**
 * E2E 场景：归档面板
 * 验证归档列表展示、卡片展开/折叠、删除归档
 */
import { test, expect } from '@playwright/test'
import { gotoApp, uploadAndWaitCompleted } from './helpers'

test.describe('归档面板', () => {
  test('归档卡片展示名称与已完成状态', async ({ page }) => {
    await gotoApp(page)
    const card = await uploadAndWaitCompleted(page, 'data.zip')
    await expect(card).toContainText('data.zip')
    await expect(card.locator('.n-tag').filter({ hasText: '已完成' })).toBeVisible()
  })

  test('点击卡片标题可折叠/展开文件树', async ({ page }) => {
    await gotoApp(page)
    const card = await uploadAndWaitCompleted(page, 'data.zip')
    const filterInput = card.getByPlaceholder('过滤文件...')
    await expect(filterInput).toBeVisible()
    // 点击标题折叠
    await card.getByText('data.zip', { exact: true }).click()
    await expect(filterInput).toBeHidden()
    // 再次点击展开
    await card.getByText('data.zip', { exact: true }).click()
    await expect(filterInput).toBeVisible()
  })

  test('点击关闭按钮删除归档', async ({ page }) => {
    await gotoApp(page)
    const card = await uploadAndWaitCompleted(page, 'data.zip')
    // NCard closable 的关闭按钮
    await card.locator('.n-base-close').click()
    await expect(page.locator('.n-card').filter({ hasText: 'data.zip' })).toHaveCount(0)
  })
})
