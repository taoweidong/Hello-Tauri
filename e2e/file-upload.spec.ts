/**
 * E2E 场景：文件上传
 * 验证 ZIP 上传解压、损坏包错误处理、非法格式拒绝
 */
import { test, expect } from '@playwright/test'
import { gotoApp, uploadAndWaitCompleted } from './helpers'

test.describe('文件上传', () => {
  test('上传 data.zip 后解压完成并展示文件树', async ({ page }) => {
    await gotoApp(page)
    const card = await uploadAndWaitCompleted(page, 'data.zip')
    // 文件树渲染出压缩包内的文件
    await expect(card.getByText('sample.txt', { exact: true })).toBeVisible()
    await expect(card.getByText('VERSION.txt', { exact: true })).toBeVisible()
  })

  test('上传损坏的 data_fail.zip 在验证阶段被拒绝并提示错误', async ({ page }) => {
    await gotoApp(page)
    await page.locator('input[type="file"]').setInputFiles('data/data_fail.zip')
    // ZipContentValidator 解析失败 → message.error 提示，不生成归档卡片
    await expect(page.locator('.n-message')).toContainText(/损坏|缺少/, { timeout: 10_000 })
    await expect(page.locator('.n-card').filter({ hasText: 'data_fail.zip' })).toHaveCount(0)
  })

  test('上传不支持的格式（.txt）被静默过滤，不生成归档', async ({ page }) => {
    await gotoApp(page)
    const input = page.locator('input[type="file"]')
    await input.setInputFiles('data/sample.txt')
    // 非压缩包扩展名在过滤阶段被静默剔除，不产生归档卡片
    await page.waitForTimeout(1_000)
    await expect(page.locator('.n-card').filter({ hasText: 'sample.txt' })).toHaveCount(0)
  })
})
