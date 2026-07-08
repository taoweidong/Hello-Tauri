<script setup lang="ts">
import { computed, ref } from 'vue'
import TabBar from './TabBar.vue'
import PreviewToolbar from './PreviewToolbar.vue'
import PreviewPane from './PreviewPane.vue'
import { useTabManager } from '@/composables/use-tabs'

const { activeTab, tabs, globalFontSize } = useTabManager()

const wrap = ref(false)
const showLineNumbers = ref(true)
const encoding = ref('utf-8')

const contentType = computed<'text' | 'csv' | 'json' | 'hex' | 'log'>(
  () => activeTab.value?.content?.type ?? 'text'
)

const hasTabs = computed(() => tabs.value.length > 0)
</script>

<template>
  <div class="flex flex-col h-full overflow-hidden">
    <TabBar />
    <template v-if="hasTabs">
      <PreviewToolbar
        :type="contentType"
        v-model:fontSize="globalFontSize"
        v-model:wrap="wrap"
        v-model:showLineNumbers="showLineNumbers"
        v-model:encoding="encoding"
      />
      <div class="flex-1 min-h-0 overflow-hidden">
        <PreviewPane :encoding="encoding" />
      </div>
    </template>
  </div>
</template>
