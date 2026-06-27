<script setup lang="ts">
import { computed } from 'vue'
import { NEmpty, NScrollbar } from 'naive-ui'
import { useTabManager } from '@/composables/use-tabs'
import { usePluginEngine } from '@/composables/use-plugins'
import ErrorBoundary from '@/components/shared/ErrorBoundary.vue'

const { activeTab } = useTabManager()
const { registry } = usePluginEngine()

const rendererComponent = computed(() => {
  if (!activeTab.value?.content) return null
  const ext = '.' + (activeTab.value.fileNode.label.split('.').pop() ?? '')
  const plugin = registry.getParser(ext)
  return plugin?.getComponent() ?? null
})
</script>

<template>
  <NEmpty v-if="!activeTab" description="选择一个文件以预览" style="margin-top: 40px;" />
  <NEmpty v-else-if="!activeTab.content" description="加载中..." style="margin-top: 40px;" />
  <NScrollbar v-else style="flex: 1;">
    <ErrorBoundary>
      <component
        :is="rendererComponent"
        :content="activeTab.content.data"
        v-if="rendererComponent"
      />
    </ErrorBoundary>
  </NScrollbar>
</template>
