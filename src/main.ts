/**
 * 应用入口文件
 * 初始化 Vue 应用实例、Pinia 状态管理、缓存系统恢复
 */
import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import 'splitpanes/dist/splitpanes.css'
import './styles/main.css'
import { initCache } from './composables/use-cache'
import { useArchiveManager } from './composables/use-archives'
import { usePluginEngine } from './composables/use-plugins'
import { setUploadExtensionsProvider } from './core/file-validator'
import { createLogger } from './core/logger'
import { PAGE_TITLE } from './config/site'

/** 应用入口日志器 */
const logger = createLogger('App')

// 运行时同步页面标题，确保与 site.ts 配置一致
document.title = PAGE_TITLE

// 上传白名单由压缩插件注册表动态生成（T4：新增格式零改动即生效）
setUploadExtensionsProvider(() => usePluginEngine().registry.getUploadExtensions())

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
    logger.warn('缓存恢复失败：', err)
  })

app.mount('#app')
