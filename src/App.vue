<script setup lang="ts">
import { onMounted, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'

import MainLayout from '@/layouts/MainLayout.vue'
import { useAppStore } from '@/stores/app'
import { useTableStore } from '@/stores/table'

const route = useRoute()
const router = useRouter()
const appStore = useAppStore()
const tableStore = useTableStore()

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
  <MainLayout />
</template>