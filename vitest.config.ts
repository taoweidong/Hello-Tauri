import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'
import { resolve } from 'path'

export default defineConfig({
  plugins: [vue()],
  define: {
    __PLATFORM__: JSON.stringify('web')
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/__tests__/setup.ts'],
    // 仅收集 src 下的单元测试，排除 e2e/ 目录（Playwright 专用）
    include: ['src/**/*.{test,spec}.ts'],
    exclude: ['node_modules/**', 'e2e/**']
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
      '@adapter': resolve(__dirname, 'src/adapters/web-adapter')
    }
  }
})
