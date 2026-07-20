<script setup lang="ts">
import { ref } from 'vue'
import { NCard, NButton, NCollapseTransition } from 'naive-ui'
import type { ArchiveItem } from '@/types'
import StatusIndicator from './StatusIndicator.vue'
import FileTree from './FileTree.vue'

const props = defineProps<{
  archive: ArchiveItem
}>()

const emit = defineEmits<{
  remove: [id: string]
  retry: [id: string]
}>()

const collapsed = ref(false)

/** 切换归档卡片的展开/折叠状态 */
function toggleCollapse() {
  collapsed.value = !collapsed.value
}
</script>

<template>
  <NCard size="small" closable class="mb-2" @close="emit('remove', archive.id)">
    <template #header>
      <div class="flex items-center gap-2 cursor-pointer select-none w-full" @click="toggleCollapse">
        <svg
          viewBox="0 0 24 24"
          width="16"
          height="16"
          fill="currentColor"
          class="transition-transform duration-200 flex-shrink-0"
          :class="{ '-rotate-90': collapsed }"
        >
          <path d="M7.41 8.59L12 13.17l4.59-4.58L18 10l-6 6-6-6 1.41-1.41z" />
        </svg>
        <span class="flex-1 truncate text-sm">{{ archive.name }}</span>
      </div>
    </template>
    <template #header-extra>
      <StatusIndicator :status="archive.status" :progress="archive.progress" />
    </template>

    <NCollapseTransition :show="!collapsed">
      <div v-if="archive.status === 'failed'" class="text-error mb-2">
        {{ archive.error }}
        <NButton size="tiny" @click="emit('retry', archive.id)">重试</NButton>
      </div>

      <div v-else-if="archive.status === 'pending'" class="text-muted mb-2">
        <NButton size="tiny" @click="emit('retry', archive.id)">重新加载</NButton>
      </div>

      <FileTree
        v-if="archive.files.length > 0"
        :data="archive.files"
        :archive-id="archive.id"
      />
    </NCollapseTransition>
  </NCard>
</template>
