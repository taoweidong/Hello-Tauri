<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { NButton, NEmpty, NInput, NSelect } from 'naive-ui'
import type { RowTreeNode } from '@/core/csv-row-tree'
import TreeNode from './TreeNode.vue'

const props = defineProps<{
  /** 选中行派生出的树形数据 */
  tree: RowTreeNode
}>()

const emit = defineEmits<{
  close: []
}>()

// 搜索关键字
const searchKeyword = ref('')
// 受控展开深度集合：null = 非受控；非 null = 受控
const expandedDepths = ref<Set<number> | null>(null)
// 当前选中的层级（用于 NSelect 显示）
const selectedLevel = ref<number | null>(null)

/**
 * 递归计算树的最大深度（根为 1，叶子节点深度）
 */
function computeDepth(node: RowTreeNode, currentDepth: number): number {
  if (node.isLeaf || !node.children || node.children.length === 0) {
    return currentDepth
  }
  let maxChildDepth = currentDepth
  for (const child of node.children) {
    const childDepth = computeDepth(child, currentDepth + 1)
    if (childDepth > maxChildDepth) maxChildDepth = childDepth
  }
  return maxChildDepth
}

// 树的最大深度（根为 1）
const maxDepth = computed<number>(() => computeDepth(props.tree, 1))

/**
 * 递归过滤树：仅保留命中关键字的节点 + 所有祖先路径
 * 命中判定：节点的 key 包含关键字（不区分大小写），或叶子节点的 value 转字符串后包含关键字
 * 算法：子节点先过滤（深度优先），节点保留条件 = 自身命中 OR 有保留的子节点
 */
function filterNode(node: RowTreeNode, keyword: string): RowTreeNode | null {
  const lowerKeyword = keyword.toLowerCase()
  // 自身命中判定
  const keyMatch = node.key.toLowerCase().includes(lowerKeyword)
  let valueMatch = false
  if (node.isLeaf && node.value !== undefined) {
    valueMatch = String(node.value).toLowerCase().includes(lowerKeyword)
  }
  const selfMatch = keyMatch || valueMatch

  // 子节点先过滤（深度优先），保留命中的子节点
  let filteredChildren: RowTreeNode[] | undefined
  if (node.children && node.children.length > 0) {
    filteredChildren = node.children
      .map(c => filterNode(c, keyword))
      .filter((c): c is RowTreeNode => c !== null)
  }

  // 节点保留条件：自身命中 OR 有任何保留的子节点
  if (selfMatch || (filteredChildren && filteredChildren.length > 0)) {
    return {
      ...node,
      children: filteredChildren,
    }
  }
  return null
}

// 过滤后的树（搜索关键字为空时返回原树）
const filteredTree = computed<RowTreeNode>(() => {
  if (!searchKeyword.value) return props.tree
  const filtered = filterNode(props.tree, searchKeyword.value)
  // 根节点始终保留（同一根），但 children 已过滤
  return filtered ?? { ...props.tree, children: [] }
})

// 层级选项数组（基于 maxDepth 生成）
const levelOptions = computed<Array<{ label: string; value: number }>>(() => {
  const opts: Array<{ label: string; value: number }> = []
  for (let i = 1; i <= maxDepth.value; i++) {
    opts.push({ label: `第 ${i} 层`, value: i })
  }
  return opts
})

/** 全部展开：展开所有深度层级 */
function expandAll(): void {
  expandedDepths.value = new Set(
    Array.from({ length: maxDepth.value }, (_, i) => i + 1),
  )
}

/** 全部折叠：仅保留根层展开 */
function collapseAll(): void {
  expandedDepths.value = new Set([1])
}

/** 按层级展开：展开指定深度及其以上所有层 */
function applyLevel(level: number): void {
  expandedDepths.value = new Set(
    Array.from({ length: level }, (_, i) => i + 1),
  )
  selectedLevel.value = level
}

/** 关闭详情面板 */
function handleClose(): void {
  emit('close')
}

// 监听搜索关键字：非空时强制展开所有深度；清空时恢复非受控模式
watch(searchKeyword, newVal => {
  if (newVal) {
    // 关键字非空：强制展开所有深度（让用户看到所有命中），不改变 selectedLevel
    expandedDepths.value = new Set(
      Array.from({ length: maxDepth.value }, (_, i) => i + 1),
    )
  } else {
    // 关键字清空：恢复非受控模式，重置选中层级
    expandedDepths.value = null
    selectedLevel.value = null
  }
})

// 暴露内部状态与方法（供测试使用）
defineExpose({
  searchKeyword,
  expandedDepths,
  selectedLevel,
  maxDepth,
  filteredTree,
  levelOptions,
  expandAll,
  collapseAll,
  applyLevel,
  handleClose,
})
</script>

<template>
  <div class="csv-tree-detail">
    <!-- 顶部工具栏 -->
    <div class="toolbar">
      <NInput
        v-model:value="searchKeyword"
        placeholder="搜索键名或值..."
        size="small"
        clearable
        style="flex: 1; min-width: 120px;"
      />
      <NButton size="small" @click="expandAll">全部展开</NButton>
      <NButton size="small" @click="collapseAll">全部折叠</NButton>
      <NSelect
        v-if="maxDepth > 1"
        :value="selectedLevel"
        :options="levelOptions"
        size="small"
        placeholder="按层级"
        style="width: 110px;"
        @update:value="applyLevel"
      />
      <NButton size="small" quaternary @click="handleClose" aria-label="关闭">
        ✕
      </NButton>
    </div>

    <!-- 树形内容区 -->
    <div class="tree-container">
      <NEmpty v-if="!tree.children || tree.children.length === 0" description="空树" />
      <NEmpty v-else-if="searchKeyword && filteredTree.children?.length === 0" description="无匹配项" />
      <TreeNode
        v-else
        :node="filteredTree"
        :depth="1"
        :search-keyword="searchKeyword"
        :expanded-depths="expandedDepths"
      />
    </div>
  </div>
</template>

<style scoped>
.csv-tree-detail {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: #1a1a2e;
  color: #d4d4d4;
  font-family: "JetBrains Mono", monospace;
  font-size: 14px;
}
.toolbar {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 8px;
  border-bottom: 1px solid #333;
  background: #16213e;
  flex-shrink: 0;
  flex-wrap: wrap;
}
.tree-container {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 8px;
}
</style>
