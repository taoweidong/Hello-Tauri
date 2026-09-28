import { createPinia } from 'pinia'
import { createApp } from 'vue'

/**
 * Element Plus 样式（P-1 按需引入后的**最小全局样式**）。
 *
 * 为什么只留这两个文件：组件级样式由 `ElementPlusResolver({ importStyle: 'css' })`
 * 在 `vite.config.ts` 里按需注入（用到的组件才带样式）。但有两样**不属于任何
 * 单个组件**、必须全局加载：
 *  * `dark/css-vars.css`：深色主题的 CSS 变量集（切主题时改 `<html>` 上的类）；
 *  * `base.css`：CSS 变量与基础排版的重置 —— 没有它，按需引入的组件样式会缺
 *    变量定义（表现为按钮没颜色、表单间距塌掉）。
 *
 * 原来那句 `element-plus/dist/index.css` 是全量样式（366 KB），已随全量注册一起移除。
 */
import 'element-plus/theme-chalk/base.css'
import 'element-plus/theme-chalk/dark/css-vars.css'
import '@/styles/index.css'

import App from '@/App.vue'
import router from '@/router'

/**
 * 注意这里**不再** `use(ElementPlus)`（P-1）。
 *
 * 全量注册会把 Element Plus 的所有组件（含未使用的）打进产物，主 chunk 1.06 MB。
 * 现在组件由 `unplugin-vue-components` 在模板编译期按需解析，命令式 API
 * （`ElMessage` / `ElMessageBox`）由 `unplugin-auto-import` 按需注入。
 *
 * 区域语言（zhCn）原先挂在全量注册的 options 上，现在改由 `App.vue` 的
 * `<el-config-provider :locale="zhCn">` 提供 —— 否则分页、日期选择器会回退英文。
 */
createApp(App).use(createPinia()).use(router).mount('#app')
