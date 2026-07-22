/**
 * 应用入口文件
 * 初始化 Vue 应用实例、Pinia 状态管理、缓存系统恢复
 */
import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import './styles/main.css'
import { initCache } from './composables/use-cache'
import { useArchiveManager } from './composables/use-archives'

const app = createApp(App)
app.use(createPinia())

// 启动时初始化缓存系统并恢复上一次的归档列表
// 异步操作不阻塞应用挂载，缓存恢复后归档列表会自动响应式更新
initCache()
  .then(() => {
    const { restoreFromCache } = useArchiveManager()
    return restoreFromCache()
  })
  .catch((err) => {
    console.warn('[Cache] 缓存恢复失败：', err)
  })

app.mount('#app')
