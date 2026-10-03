import { fileURLToPath, URL } from 'node:url'
import { readFileSync } from 'node:fs'

import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'

// 与 vite.config.ts 同源注入版本号（R-3）。测试环境不会走 vite 的 define，
// 不同步的话任何 import 到 web.ts / 视图的用例都会因 __APP_VERSION__ 未定义而炸。
const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string }

export default defineConfig({
  plugins: [vue()],
  // @ts-expect-error vitest 的 defineConfig 类型未透出 define 字段，运行时是支持的
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    environment: 'happy-dom',
    include: ['src/**/*.spec.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      reportsDirectory: 'coverage',
      // 只统计**业务源码**：入口装配、类型声明、纯样式不参与，
      // 否则「覆盖率」会被大量无逻辑的文件稀释成一个好看但无意义的数字。
      include: ['src/**/*.{ts,vue}'],
      exclude: [
        'src/**/*.spec.ts',
        'src/main.ts',
        'src/types/**',
        'src/api/types.ts',
        'src/components/icons.ts',
        // 端口/mock 实现是测试替身本身，统计它们没有意义
        'src/**/mock.ts',
      ],
      // T-1：不追求全局数字，只在**关键路径**设阈值。
      //
      // 阈值语义是「**防回退基线**」，不是「质量目标」：取实测值往下留一点余量，
      // 让「明显退步」立刻变红，而不是逼着为凑数字写无意义的测试。
      // 实测（2026-09-28，483 用例）：orchestrator 96.7% lines / 91.5% branch；
      // infra/db 聚合 75.2% lines（repos 层 74%，未覆盖多为防御性分支与
      // 浏览器专用的 UI 读路径 —— 把它们补到 80% 的收益低于成本）。
      // 后续若要提阈值，先补测试再抬线，不要反过来。
      thresholds: {
        'src/orchestrator/**': {
          // 2026-10-03 抬线（quality-hardening-2026-10 7.1）：实测 97.1/92/93，
          // 抬到 95/88/90 留 2~3 个百分点余量 —— 防回退基线，不追高点。
          lines: 95,
          functions: 90,
          statements: 95,
          branches: 88,
        },
        'src/infra/db/**': {
          lines: 72,
          functions: 68,
          statements: 72,
          branches: 68,
        },
        'src/infra/windows/**': {
          // 2026-10-03 新增（quality-hardening-2026-10 7.1）：实测 97/93.2/80，
          // windows-infra 模块的防回退基线。
          lines: 90,
          functions: 75,
          statements: 90,
          branches: 88,
        },
      },
    },
  },
})
