<script setup lang="ts">
import { computed, ref } from 'vue'
import TabBar from './TabBar.vue'
import PreviewToolbar from './PreviewToolbar.vue'
import PreviewPane from './PreviewPane.vue'
import StatusBar from './StatusBar.vue'
import { useTabManager } from '@/composables/use-tabs'

const { activeTab } = useTabManager()

const fontSize = ref(14)
const wrap = ref(false)
const showLineNumbers = ref(true)
const encoding = ref('utf-8')

const contentType = computed<'text' | 'csv' | 'json' | 'hex' | 'log'>(
  () => activeTab.value?.content?.type ?? 'text'
)
</script>

<template>
  <div class="workspace-container">
    <TabBar />
    <PreviewToolbar
      v-if="activeTab?.content"
      :type="contentType"
      v-model:fontSize="fontSize"
      v-model:wrap="wrap"
      v-model:showLineNumbers="showLineNumbers"
      v-model:encoding="encoding"
    />
    <div class="preview-pane-wrapper">
      <PreviewPane :encoding="encoding" />
    </div>
    <StatusBar />
  </div>
</template>

<style scoped>
.workspace-container {
  height: 100%;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.preview-pane-wrapper {
  flex: 1;
  min-height: 0;
  overflow: hidden;
}
</style>
