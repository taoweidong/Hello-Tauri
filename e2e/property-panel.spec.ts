/**
 * E2E 场景：属性面板
 * 验证压缩包信息与文件元数据展示
 */
import { test, expect } from '@playwright/test'
import { gotoApp, uploadAndWaitCompleted, openFileFromTree } from './helpers'

test.describe('属性面板', () => {
  test('未选择文件时显示空态提示', async ({ page }) => {
    await gotoApp(page)
    const panel = page.locator('aside').nth(1)
    await expect(panel).toContainText('压缩包信息')
    await expect(panel).toContainText('文件信息')
    await expect(panel).toContainText('未选择压缩包')
    await expect(panel).toContainText('选择文件查看详情')
  })

  test('打开文件后展示元数据与所属压缩包信息', async ({ page }) => {
    await gotoApp(page)
    const card = await uploadAndWaitCompleted(page, 'data.zip')
    await openFileFromTree(page, card, 'sample.txt')
    const panel = page.locator('aside').nth(1)
    // 文件元数据
    await expect(panel).toContainText('文件名')
    await expect(panel).toContainText('sample.txt')
    // 所属压缩包信息
    await expect(panel).toContainText('data.zip')
    await expect(panel).toContainText('文件数')
    await expect(panel).toContainText('5 个')
  })
})
