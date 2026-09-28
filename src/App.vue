<script setup lang="ts">
import { onMounted, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import zhCn from 'element-plus/es/locale/lang/zh-cn'

import MainLayout from '@/layouts/MainLayout.vue'
import { useAppStore } from '@/stores/app'
import { useTableStore } from '@/stores/table'

const route = useRoute()
const router = useRouter()
const appStore = useAppStore()
const tableStore = useTableStore()

/**
 * Element Plus 区域语言（P-1）。
 *
 * 为什么从 `main.ts` 搬到这里：原先挂在 `app.use(ElementPlus, { locale: zhCn })`
 * 上，而全量注册已被按需引入取代（见 `main.ts` 注释）。`ConfigProvider` 是
 * Element Plus 官方在按需引入场景下的 locale 注入方式 —— 少了它，分页
 * （`el-pagination`）与日期/时间选择器会显示英文。
 *
 * 作用域用 `ConfigProvider` 包住 `MainLayout`：`ElMessage` / `ElMessageBox`
 * 这类命令式 API 的 locale 由组件内的 `ConfigProvider` 上下文决定，
 * 因此必须在应用根部提供。
 */
const locale = zhCn

onMounted(async () => {
  await appStore.load()
  await tableStore.load()

  // 每页条数唯一真值在配置里，启动时向表格注入（表格侧只读消费）
  tableStore.pageSize = appStore.settings.pageSize

  const target = appStore.settings.defaultRoute
  if (target && target !== '/' && route.path === '/') {
    void router.replace(target)
  }
})

// 配置改动实时同步到表格分页，修复 keep-alive 后配置不生效的问题
watch(
  () => appStore.settings.pageSize,
  (size) => {
    tableStore.pageSize = size
  },
)
</script>

<template>
  <el-config-provider :locale="locale">
    <MainLayout />
  </el-config-provider>
</template>
