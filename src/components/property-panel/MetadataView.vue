<script setup lang="ts">
/**
 * 文件元数据视图
 * 展示当前活动标签页的文件名、路径、大小、类型、行数、解析插件与加载耗时
 */
import { NDescriptions, NDescriptionsItem } from 'naive-ui'
import { useTabManager } from '@/composables/use-tabs'

const { activeTab } = useTabManager()
</script>

<template>
  <div v-if="activeTab">
    <NDescriptions label-placement="left" size="small" bordered :column="1">
      <NDescriptionsItem label="文件名">
        {{ activeTab.fileNode.label }}
      </NDescriptionsItem>
      <NDescriptionsItem label="路径">
        {{ activeTab.fileNode.path }}
      </NDescriptionsItem>
      <NDescriptionsItem label="大小">
        {{ activeTab.fileNode.size !== undefined ? `${activeTab.fileNode.size} B` : '-' }}
      </NDescriptionsItem>
      <NDescriptionsItem label="类型" v-if="activeTab.content">
        {{ activeTab.content.type }}
      </NDescriptionsItem>
      <NDescriptionsItem label="行数" v-if="activeTab.content?.lineCount">
        {{ activeTab.content.lineCount }}
      </NDescriptionsItem>
      <NDescriptionsItem label="解析插件" v-if="activeTab.content">
        {{ activeTab.content.pluginName }}
      </NDescriptionsItem>
      <NDescriptionsItem label="加载耗时" v-if="activeTab.content?.loadTimeMs !== undefined">
        {{ activeTab.content.loadTimeMs.toFixed(1) }} ms
      </NDescriptionsItem>
    </NDescriptions>
  </div>
  <div v-else class="empty-hint">
    选择文件查看详情
  </div>
</template>

<style scoped>
.empty-hint {
  text-align: center;
  padding: 16px 0;
  color: var(--text-secondary, #666);
  font-size: 12px;
}
</style>
