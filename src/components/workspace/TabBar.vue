<script setup lang="ts">
import { computed } from 'vue'
import { NTabs, NTab } from 'naive-ui'
import { useTabManager } from '@/composables/use-tabs'

const { tabs, activeTabId, activateTab, closeTab, togglePin } = useTabManager()

const tabValue = computed(() => activeTabId.value ?? undefined)
</script>

<template>
  <NTabs
    v-if="tabs.length > 0"
    type="card"
    :value="tabValue"
    closable
    @update:value="activateTab"
    @close="closeTab"
  >
    <NTab
      v-for="tab in tabs"
      :key="tab.id"
      :name="tab.id"
      :closable="!tab.pinned"
    >
      {{ tab.pinned ? '📌 ' : '' }}{{ tab.fileNode.label }}
    </NTab>
  </NTabs>
  <div v-else style="display: flex; align-items: center; justify-content: center; height: 40px; color: #666;">
    点击左侧文件树中的文件以预览
  </div>
</template>
