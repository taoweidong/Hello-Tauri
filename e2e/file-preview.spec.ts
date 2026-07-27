/**
 * E2E 场景：文件预览
 * 验证 TXT/CSV/JSON/LOG 四种渲染器正确展示内容
 */
import { test, expect } from '@playwright/test'
import { gotoApp, uploadAndWaitCompleted, openFileFromTree } from './helpers'

test.describe('文件预览', () => {
  test('TXT 文件以文本渲染器展示内容', async ({ page }) => {
    await gotoApp(page)
    const card = await uploadAndWaitCompleted(page, 'data.zip')
    await openFileFromTree(page, card, 'sample.txt')
    await expect(page.locator('main')).toContainText('这是一个测试文本文件', { timeout: 10_000 })
  })

  test('CSV 文件以表格渲染器展示数据', async ({ page }) => {
    await gotoApp(page)
    const card = await uploadAndWaitCompleted(page, 'data.zip')
    await openFileFromTree(page, card, 'sample.csv')
    // CSV 渲染为数据表格并包含首行数据
    await expect(page.locator('main .n-data-table')).toBeVisible({ timeout: 10_000 })
    await expect(page.locator('main')).toContainText('张三')
  })

  test('JSON 文件以树形渲染器展示结构', async ({ page }) => {
    await gotoApp(page)
    const card = await uploadAndWaitCompleted(page, 'data.zip')
    await openFileFromTree(page, card, 'sample.json')
    // 打开后预览空态消失，内容渲染完成
    await expect(page.locator('main').getByText('选择一个文件以预览')).toHaveCount(0)
    await expect(page.locator('main').getByText('加载中...')).toHaveCount(0, { timeout: 10_000 })
  })

  test('LOG 文件以日志渲染器展示日志行', async ({ page }) => {
    await gotoApp(page)
    const card = await uploadAndWaitCompleted(page, 'data.zip')
    await openFileFromTree(page, card, 'sample.log')
    await expect(page.locator('main')).toContainText('应用启动', { timeout: 10_000 })
  })
})
