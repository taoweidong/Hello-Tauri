<script setup lang="ts">
import { onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'

import MainLayout from '@/layouts/MainLayout.vue'
import { useAppStore } from '@/stores/app'

const route = useRoute()
const router = useRouter()
const appStore = useAppStore()

onMounted(async () => {
  await appStore.load()
  const target = appStore.settings.defaultRoute
  if (target && target !== '/' && route.path === '/') {
    void router.replace(target)
  }
})
</script>

<template>
  <MainLayout />
</template>
