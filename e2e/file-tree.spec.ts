/**
 * E2E 场景：文件树导航
 * 验证树节点渲染、关键字过滤、点击打开标签页
 */
import { test, expect } from '@playwright/test'
import { gotoApp, uploadAndWaitCompleted, openFileFromTree } from './helpers'

test.describe('文件树导航', () => {
  test('树节点渲染压缩包内全部文件', async ({ page }) => {
    await gotoApp(page)
    const card = await uploadAndWaitCompleted(page, 'data.zip')
    for (const name of ['sample.csv', 'sample.json', 'sample.log', 'sample.txt', 'VERSION.txt']) {
      await expect(card.getByText(name, { exact: true })).toBeVisible()
    }
  })

  test('关键字过滤仅显示匹配文件', async ({ page }) => {
    await gotoApp(page)
    const card = await uploadAndWaitCompleted(page, 'data.zip')
    await card.getByPlaceholder('过滤文件...').fill('csv')
    await expect(card.getByText('sample.csv', { exact: true })).toBeVisible()
    await expect(card.getByText('sample.txt', { exact: true })).toBeHidden()
    await expect(card.getByText('VERSION.txt', { exact: true })).toBeHidden()
  })

  test('点击叶子节点打开预览标签页', async ({ page }) => {
    await gotoApp(page)
    const card = await uploadAndWaitCompleted(page, 'data.zip')
    await openFileFromTree(page, card, 'sample.txt')
    await expect(page.locator('.tab-item.tab-active')).toContainText('sample.txt')
  })
})
