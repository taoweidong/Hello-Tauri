/**
 * Playwright E2E 测试配置
 * 按 docs/full-pipeline-test.md P7 阶段要求配置：
 * - 测试目录 e2e/，复用本地 dev server（端口 5173）
 * - 失败时截图，首次重试时记录 trace
 */
import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  retries: 1,
  // 本地串行执行，避免多个 worker 同时操作 IndexedDB 缓存互相干扰
  workers: 1,
  use: {
    baseURL: 'http://localhost:5173',
    screenshot: 'only-on-failure',
    trace: 'on-first-retry',
  },
  webServer: {
    command: 'npm run dev',
    port: 5173,
    reuseExistingServer: true,
    timeout: 60_000,
  },
})
