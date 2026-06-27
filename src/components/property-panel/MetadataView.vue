<script setup lang="ts">
import { NDescriptions, NDescriptionsItem } from 'naive-ui'
import { useTabManager } from '@/composables/use-tabs'

const { activeTab } = useTabManager()
</script>

<template>
  <div v-if="activeTab">
    <NDescriptions label-placement="left" size="small" bordered>
      <NDescriptionsItem label="文件名">
        {{ activeTab.fileNode.label }}
      </NDescriptionsItem>
      <NDescriptionsItem label="路径">
        {{ activeTab.fileNode.path }}
      </NDescriptionsItem>
      <NDescriptionsItem label="大小">
        {{ activeTab.fileNode.size ?? '-' }} B
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
    </NDescriptions>
  </div>
  <div v-else style="color: #666; text-align: center; margin-top: 20px;">
    选择文件查看属性
  </div>
</template>
