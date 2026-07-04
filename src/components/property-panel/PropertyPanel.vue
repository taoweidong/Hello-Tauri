<script setup lang="ts">
import { NScrollbar } from 'naive-ui'
import ArchiveInfo from './ArchiveInfo.vue'
import MetadataView from './MetadataView.vue'
import PathBreadcrumb from './PathBreadcrumb.vue'
</script>

<template>
  <div class="property-panel">
    <NScrollbar class="property-scrollbar">
      <!-- 上半部分：压缩包信息 -->
      <ArchiveInfo />
      
      <!-- 下半部分：当前文件信息 -->
      <div class="file-info-section">
        <div class="section-title">文件信息</div>
        <MetadataView />
        <PathBreadcrumb />
      </div>
    </NScrollbar>
  </div>
</template>

<style scoped>
.property-panel {
  height: 100%;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.property-scrollbar {
  flex: 1;
  min-height: 0;
  padding: 12px;
}

.file-info-section {
  margin-top: 8px;
}

.section-title {
  font-size: 13px;
  font-weight: 600;
  margin-bottom: 8px;
  padding-bottom: 6px;
  border-bottom: 1px solid var(--border, #333);
  color: var(--text-primary, #fff);
}
</style>
