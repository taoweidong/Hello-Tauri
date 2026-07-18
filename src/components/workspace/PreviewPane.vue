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

/** 解析请求 ID，用于防止并发 resolve 的竞态条件 */
let resolveRequestId = 0

/** 解析当前文件内容，失败时保持原状态 */
async function resolveCurrentFile(encoding: string) {
  const tab = activeTab.value
  if (!tab) return
  const requestId = ++resolveRequestId
  try {
    const engine = await getEngine()
    const content = await engine.resolveFile(tab.fileNode, '', encoding)
    // 仅在请求仍为最新时应用结果
    if (requestId === resolveRequestId && content) {
      tab.content = content
    }
  } catch (e) {
    console.warn('[PreviewPane] 文件解析失败', e)
  }
}

/** 当标签页切换或编码变更时，重新解析文件（合并为单个 watch 避免竞态） */
watch(
  () => [activeTab.value?.id, props.encoding] as const,
  ([, encoding]) => {
    const tab = activeTab.value
    if (!tab) return
    // 标签切换时清空旧内容，编码变更时强制重新解析
    if (!tab.content || encoding !== undefined) {
      resolveCurrentFile(encoding ?? 'utf-8')
    }
  },
  { immediate: true },
)

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
    <!--
      CSV 渲染器内部使用 Splitpanes 实现左右分栏，且 DataTable 与 CsvTreeDetail 各自管理滚动。
      若外层再用 NScrollbar 包裹，Splitpanes 的 height:100% 会因 NScrollbar 内容容器高度 auto 而塌陷，
      导致左右分栏退化为上下堆叠。因此 CSV 类型直接渲染，其余类型保留 NScrollbar。
    -->
    <div v-else-if="activeTab.content.type === 'csv'" class="preview-full">
      <ErrorBoundary>
        <component
          :is="rendererComponent"
          :content="activeTab.content.data"
          v-if="rendererComponent"
        />
      </ErrorBoundary>
    </div>
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

.preview-full {
  flex: 1;
  min-height: 0;
  overflow: hidden;
}
</style>
