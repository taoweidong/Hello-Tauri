<script setup lang="ts">
import { NEmpty } from 'naive-ui'
import { useTabManager } from '@/composables/use-tabs'
import JsonNode from './JsonNode.vue'

defineProps<{ content: unknown }>()
const { globalFontSize } = useTabManager()
</script>

<template>
  <NEmpty
    v-if="content === null || content === undefined"
    description="空内容"
    style="margin-top: 40px;"
  />
  <div v-else class="json-renderer" :style="{ fontSize: `${globalFontSize}px` }">
    <JsonNode :node="content" :default-open="true" />
  </div>
</template>

<style scoped>
.json-renderer {
  font-family: "JetBrains Mono", monospace;
  font-size: 14px;
  padding: 8px;
  overflow: auto;
  height: 100%;
  background: var(--color-editor-bg);
  color: var(--color-editor-text);
}
</style>
