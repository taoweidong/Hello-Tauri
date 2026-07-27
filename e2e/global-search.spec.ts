/**
 * E2E 场景：全局搜索
 * 验证 Ctrl+K 唤起、关键字搜索、结果导航打开标签页
 */
import { test, expect } from '@playwright/test'
import { gotoApp, uploadAndWaitCompleted } from './helpers'

test.describe('全局搜索', () => {
  test('Ctrl+K 聚焦搜索输入框', async ({ page }) => {
    await gotoApp(page)
    await page.keyboard.press('Control+k')
    await expect(page.getByPlaceholder('搜索文件名...')).toBeFocused()
  })

  test('输入关键字后展示匹配结果统计', async ({ page }) => {
    await gotoApp(page)
    await uploadAndWaitCompleted(page, 'data.zip')
    await page.getByPlaceholder('搜索文件名...').fill('sample')
    // 300ms 防抖后结果面板更新，sample.* 共 4 个文件
    const panel = page.locator('.global-search-wrapper')
    await expect(panel).toContainText('找到 4 个文件', { timeout: 5_000 })
  })

  test('点击搜索结果打开对应标签页', async ({ page }) => {
    await gotoApp(page)
    await uploadAndWaitCompleted(page, 'data.zip')
    await page.getByPlaceholder('搜索文件名...').fill('sample.log')
    const wrapper = page.locator('.global-search-wrapper')
    // 等待防抖完成、结果条目渲染（高亮 mark 出现）后再点击
    await expect(wrapper).toContainText('找到 1 个文件', { timeout: 5_000 })
    await wrapper.locator('mark').first().click()
    await expect(page.locator('.tab-item.tab-active')).toContainText('sample.log')
  })
})
