/**
 * E2E 测试共享工具函数
 * 封装应用访问、压缩包上传、文件树打开等常用操作
 */
import { expect, type Page, type Locator } from '@playwright/test'
import path from 'node:path'

/** 测试数据目录（Playwright 运行时 cwd 为项目根目录） */
export const DATA_DIR = path.resolve(process.cwd(), 'data')

/** 访问应用首页并等待布局渲染完成 */
export async function gotoApp(page: Page): Promise<void> {
  await page.goto('/')
  // 顶部导航栏渲染出应用名即视为加载完成
  await expect(page.locator('header')).toContainText('Hello Tauri')
}

/** 通过隐藏的文件输入框上传文件，返回对应归档卡片定位器 */
export async function uploadArchive(page: Page, fileName = 'data.zip'): Promise<Locator> {
  await page.locator('input[type="file"]').setInputFiles(path.join(DATA_DIR, fileName))
  const card = page.locator('.n-card').filter({ hasText: fileName })
  await expect(card).toBeVisible({ timeout: 10_000 })
  return card
}

/** 上传压缩包并等待解压完成（状态标签变为「已完成」） */
export async function uploadAndWaitCompleted(page: Page, fileName = 'data.zip'): Promise<Locator> {
  const card = await uploadArchive(page, fileName)
  await expect(card.locator('.n-tag').filter({ hasText: '已完成' })).toBeVisible({ timeout: 15_000 })
  return card
}

/** 在归档卡片的文件树中点击指定文件，等待对应标签页出现 */
export async function openFileFromTree(page: Page, card: Locator, fileName: string): Promise<void> {
  await card.getByText(fileName, { exact: true }).click()
  await expect(page.locator('.tab-item').filter({ hasText: fileName })).toBeVisible({ timeout: 10_000 })
}
