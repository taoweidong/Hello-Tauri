<script setup lang="ts">
import { computed, watch } from 'vue'
import { NEmpty, NScrollbar } from 'naive-ui'
import { useTabManager } from '@/composables/use-tabs'
import { usePluginEngine } from '@/composables/use-plugins'
import { usePlatform } from '@/composables/use-platform'
import { ParserEngine } from '@/core/parser-engine'
import ErrorBoundary from '@/components/shared/ErrorBoundary.vue'

const props = defineProps<{
  encoding?: string
}>()

const { activeTab } = useTabManager()
const { registry } = usePluginEngine()
const { getAdapter } = usePlatform()

let enginePromise: Promise<ParserEngine> | null = null

/** 获取 ParserEngine 单例 */
async function getEngine() {
  if (!enginePromise) {
    const adapter = await getAdapter()
    enginePromise = Promise.resolve(new ParserEngine(adapter, registry))
  }
  return enginePromise
}

/** 解析当前文件内容，失败时保持原状态 */
async function resolveCurrentFile(encoding: string) {
  const tab = activeTab.value
  if (!tab) return
  try {
    const engine = await getEngine()
    const content = await engine.resolveFile(tab.fileNode, '', encoding)
    if (content) {
      tab.content = content
    }
  } catch {
    // 解析失败，保持当前状态
  }
}

/** 当标签页切换或编码变更时，重新解析文件 */
watch(
  () => [activeTab.value, props.encoding] as const,
  ([tab, encoding]) => {
    if (!tab || tab.content) return
    resolveCurrentFile(encoding ?? 'utf-8')
  },
  { immediate: true },
)

/** 编码变更时重新解析当前文件 */
watch(() => props.encoding, (newEncoding) => {
  if (activeTab.value) {
    resolveCurrentFile(newEncoding ?? 'utf-8')
  }
})

const rendererComponent = computed(() => {
  if (!activeTab.value?.content) return null
  const dotIndex = activeTab.value.fileNode.label.lastIndexOf('.')
  const ext = dotIndex > 0 ? activeTab.value.fileNode.label.slice(dotIndex) : ''
  const plugin = registry.getParser(ext)
  return plugin?.getComponent() ?? null
})
</script>

<template>
  <div class="preview-container">
    <NEmpty v-if="!activeTab" description="选择一个文件以预览" />
    <NEmpty v-else-if="!activeTab.content" description="加载中..." />
    <NScrollbar v-else class="preview-scrollbar">
      <ErrorBoundary>
        <component
          :is="rendererComponent"
          :content="activeTab.content.data"
          v-if="rendererComponent"
        />
      </ErrorBoundary>
    </NScrollbar>
  </div>
</template>

<style scoped>
.preview-container {
  height: 100%;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.preview-scrollbar {
  flex: 1;
  min-height: 0;
}
</style>
