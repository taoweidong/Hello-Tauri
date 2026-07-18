<script setup lang="ts">
import { computed } from 'vue'
import { NDescriptions, NDescriptionsItem, NTag } from 'naive-ui'
import { useTabManager } from '@/composables/use-tabs'
import { useArchiveManager } from '@/composables/use-archives'
import { formatSize, formatDuration } from '@/core/format'
import type { ArchiveStatus } from '@/types'

const { activeTab } = useTabManager()
const { archives } = useArchiveManager()

// 获取当前文件所属的压缩包
const currentArchive = computed(() => {
  if (!activeTab.value) return null
  return archives.value.find(a => a.id === activeTab.value!.archiveId) ?? null
})

// 获取 VERSION.txt 内容
const versionInfo = computed(() => {
  const archive = currentArchive.value
  if (!archive) return null
  
  const versionFile = archive.files.find(f => 
    f.label === 'VERSION.txt' || f.path.endsWith('VERSION.txt')
  )
  if (!versionFile) return null
  
  return {
    version: versionFile.size !== undefined ? `${versionFile.size} bytes` : '-',
    path: versionFile.path
  }
})

// 解压耗时
const decompressDuration = computed(() => {
  const archive = currentArchive.value
  if (!archive?.startTime || !archive?.endTime) return '-'
  return formatDuration(archive.endTime - archive.startTime)
})

/** 状态 → NTag 类型映射 */
const STATUS_TAG_TYPE: Record<ArchiveStatus, 'success' | 'error' | 'warning' | 'default'> = {
  completed: 'success',
  failed: 'error',
  running: 'warning',
  pending: 'default',
}

/** 状态 → 中文标签映射 */
const STATUS_LABEL: Record<ArchiveStatus, string> = {
  completed: '已完成',
  failed: '失败',
  running: '解压中',
  pending: '等待中',
}
</script>

<template>
  <div class="archive-info-section">
    <div class="section-title">压缩包信息</div>
    
    <template v-if="currentArchive">
      <NDescriptions label-placement="left" size="small" bordered :column="1">
        <NDescriptionsItem label="名称">
          {{ currentArchive.name }}
        </NDescriptionsItem>
        <NDescriptionsItem label="状态">
          <NTag 
            :type="STATUS_TAG_TYPE[currentArchive.status]"
            size="small"
          >
            {{ STATUS_LABEL[currentArchive.status] }}
          </NTag>
        </NDescriptionsItem>
        <NDescriptionsItem label="压缩大小">
          {{ formatSize(currentArchive.compressedSize) }}
        </NDescriptionsItem>
        <NDescriptionsItem label="原始大小" v-if="currentArchive.originalSize > 0">
          {{ formatSize(currentArchive.originalSize) }}
        </NDescriptionsItem>
        <NDescriptionsItem label="文件数">
          {{ currentArchive.files.length }} 个
        </NDescriptionsItem>
        <NDescriptionsItem label="解压耗时" v-if="currentArchive.endTime">
          {{ decompressDuration }}
        </NDescriptionsItem>
        <NDescriptionsItem label="版本文件" v-if="versionInfo">
          <span style="font-size: 12px; opacity: 0.7;">{{ versionInfo.path }}</span>
        </NDescriptionsItem>
      </NDescriptions>
    </template>
    
    <div v-else class="empty-hint">
      未选择压缩包
    </div>
  </div>
</template>

<style scoped>
.archive-info-section {
  margin-bottom: 16px;
}

.section-title {
  font-size: 13px;
  font-weight: 600;
  margin-bottom: 8px;
  padding-bottom: 6px;
  border-bottom: 1px solid var(--color-border);
  color: var(--color-text-primary);
}

.empty-hint {
  text-align: center;
  padding: 20px 0;
  color: var(--color-text-secondary);
  font-size: 12px;
}
</style>
