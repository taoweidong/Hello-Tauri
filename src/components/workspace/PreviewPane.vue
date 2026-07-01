<script setup lang="ts">
import { computed, watch } from 'vue'
import { NEmpty, NScrollbar } from 'naive-ui'
import { useTabManager } from '@/composables/use-tabs'
import { usePluginEngine } from '@/composables/use-plugins'
import { usePlatform } from '@/composables/use-platform'
import { ParserEngine } from '@/core/parser-engine'
import ErrorBoundary from '@/components/shared/ErrorBoundary.vue'

const { activeTab } = useTabManager()
const { registry } = usePluginEngine()
const { getAdapter } = usePlatform()

let enginePromise: Promise<ParserEngine> | null = null

async function getEngine() {
  if (!enginePromise) {
    const adapter = await getAdapter()
    enginePromise = Promise.resolve(new ParserEngine(adapter, registry))
  }
  return enginePromise
}

watch(activeTab, async (tab) => {
  if (!tab || tab.content) return
  try {
    const engine = await getEngine()
    const content = await engine.resolveFile(tab.fileNode, '')
    if (content) {
      tab.content = content
    }
  } catch {
    // 加载失败，保持 loading 状态
  }
}, { immediate: true })

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
