import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { resolve } from 'path'

const platform = process.env.VITE_PLATFORM || 'web'

export default defineConfig({
  plugins: [vue()],
  define: {
    __PLATFORM__: JSON.stringify(platform)
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
      '@adapter': platform === 'tauri'
        ? resolve(__dirname, 'src/adapters/tauri-adapter')
        : resolve(__dirname, 'src/adapters/web-adapter')
    }
  },
  build: {
    outDir: 'build/web',
    emptyOutDir: true,
    rolldownOptions: {
      external: platform === 'web' ? [/@tauri-apps\/api/] : []
    }
  }
})
