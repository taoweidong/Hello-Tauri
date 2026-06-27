<script setup lang="ts">
import { computed } from 'vue'
import { NBreadcrumb, NBreadcrumbItem } from 'naive-ui'
import { useTabManager } from '@/composables/use-tabs'

const { activeTab } = useTabManager()

const pathSegments = computed(() => {
  if (!activeTab.value) return []
  return activeTab.value.fileNode.path.split('/').filter(Boolean)
})
</script>

<template>
  <NBreadcrumb v-if="pathSegments.length > 0" style="margin-top: 12px;">
    <NBreadcrumbItem v-for="(seg, i) in pathSegments" :key="i">
      {{ seg }}
    </NBreadcrumbItem>
  </NBreadcrumb>
</template>
