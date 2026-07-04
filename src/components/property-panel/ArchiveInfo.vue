<script setup lang="ts">
import { computed } from 'vue'
import { NDescriptions, NDescriptionsItem, NTag } from 'naive-ui'
import { useTabManager } from '@/composables/use-tabs'
import { useArchiveManager } from '@/composables/use-archives'

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
  
  // 查找 VERSION.txt 文件
  const versionFile = archive.files.find(f => 
    f.label === 'VERSION.txt' || f.path.endsWith('VERSION.txt')
  )
  
  if (!versionFile) return null
  
  // 尝试从文件内容中获取版本信息
  // 这里假设 VERSION.txt 已经被解析过
  return {
    version: versionFile.size !== undefined ? `${versionFile.size} bytes` : '-',
    path: versionFile.path
  }
})

// 格式化文件大小
function formatSize(bytes: number): string {
  if (bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i]
}

// 计算解压耗时
const decompressDuration = computed(() => {
  const archive = currentArchive.value
  if (!archive?.startTime || !archive?.endTime) return '-'
  const ms = archive.endTime - archive.startTime
  if (ms < 1000) return `${ms} ms`
  return `${(ms / 1000).toFixed(2)} s`
})
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
            :type="currentArchive.status === 'completed' ? 'success' : 
                   currentArchive.status === 'failed' ? 'error' : 
                   currentArchive.status === 'running' ? 'warning' : 'default'"
            size="small"
          >
            {{ currentArchive.status === 'completed' ? '已完成' :
               currentArchive.status === 'failed' ? '失败' :
               currentArchive.status === 'running' ? '解压中' : '等待中' }}
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
          <span style="font-size: 11px; opacity: 0.7;">{{ versionInfo.path }}</span>
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
  border-bottom: 1px solid var(--border, #333);
  color: var(--text-primary, #fff);
}

.empty-hint {
  text-align: center;
  padding: 20px 0;
  color: var(--text-secondary, #666);
  font-size: 12px;
}
</style>
