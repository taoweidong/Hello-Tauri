<script setup lang="ts">
import { ref } from 'vue'
import { NTree, NInput } from 'naive-ui'
import type { FileTreeNode } from '@/types'
import { useTabManager } from '@/composables/use-tabs'
import { FileTreeBuilder } from '@/core/file-tree'

const props = defineProps<{
  data: FileTreeNode[]
  archiveId: string
}>()

const { openTab } = useTabManager()
const pattern = ref('')

/** 处理树节点选中事件，叶子节点时打开标签页 */
function handleSelect(keys: string[]) {
  if (keys.length === 0) return
  const key = keys[0]
  const node = FileTreeBuilder.findNode(props.data, key)
  if (node?.isLeaf) {
    openTab(node, props.archiveId)
  }
}
</script>

<template>
  <div>
    <NInput v-model:value="pattern" placeholder="过滤文件..." size="small" clearable style="margin-bottom: 4px;" />
    <NTree
      :data="data as any"
      :pattern="pattern"
      :show-irrelevant-nodes="false"
      virtual-scroll
      style="max-height: 300px;"
      selectable
      :default-expand-all="false"
      @update:selected-keys="handleSelect"
      block-line
    />
  </div>
</template>
