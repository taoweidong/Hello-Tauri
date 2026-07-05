// 临时调试脚本
import { defineConfig } from 'vitest/config'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

// 测试是否有 __dirname 的问题
console.log('typeof __dirname:', typeof __dirname)
try {
  console.log('__dirname value:', __dirname)
} catch(e) {
  console.log('__dirname error:', e.message)
}

try {
  console.log('import.meta.url:', import.meta.url)
  console.log('import.meta.dirname:', import.meta.dirname)
} catch(e) {
  console.log('import.meta error:', e.message)
}

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/__tests__/_minimal.test.ts'],
  },
})
