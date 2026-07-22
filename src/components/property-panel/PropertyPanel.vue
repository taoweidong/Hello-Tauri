<script setup lang="ts">
/**
 * 右侧属性面板
 * 上半部分展示压缩包信息，下半部分展示当前文件元数据与路径面包屑
 */
import { NScrollbar } from 'naive-ui'
import ArchiveInfo from './ArchiveInfo.vue'
import MetadataView from './MetadataView.vue'
import PathBreadcrumb from './PathBreadcrumb.vue'
</script>

<template>
  <div class="flex flex-col h-full overflow-hidden">
    <NScrollbar class="flex-1 min-h-0 p-3">
      <!-- 上半部分：压缩包信息 -->
      <ArchiveInfo />
      
      <!-- 下半部分：当前文件信息 -->
      <div class="mt-2">
        <div class="text-[13px] font-semibold mb-2 pb-1.5 border-b border-border text-text-primary">
          文件信息
        </div>
        <MetadataView />
        <PathBreadcrumb />
      </div>
    </NScrollbar>
  </div>
</template>
