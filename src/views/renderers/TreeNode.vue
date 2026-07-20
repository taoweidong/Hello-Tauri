<script setup lang="ts">
import { computed, ref } from 'vue'
import type { RowTreeNode } from '@/core/csv-row-tree'
// 显式自引用以支持递归渲染
import TreeNode from './TreeNode.vue'

const props = defineProps<{
  /** 当前节点 */
  node: RowTreeNode
  /** 当前深度（根为 1） */
  depth: number
  /** 搜索关键字（用于高亮） */
  searchKeyword?: string
  /** 受控展开深度集合：null 表示非受控（用节点自身 open 状态）；Set<number> 表示深度在该集合中的节点展开 */
  expandedDepths?: Set<number> | null
}>()

// 内部展开状态（仅非受控模式使用），默认展开
const internalOpen = ref(true)

// 当前是否展开：受控模式取自 expandedDepths，非受控模式取自内部 ref
const isOpen = computed<boolean>(() => {
  if (props.expandedDepths != null) {
    return props.expandedDepths.has(props.depth)
  }
  return internalOpen.value
})

// 根节点特殊处理：depth === 1 且 key === 'root' 时不显示 key 行
const isRoot = computed<boolean>(() => props.depth === 1 && props.node.key === 'root')

/** 切换展开/折叠（受控模式下为空操作） */
function toggle(): void {
  if (props.expandedDepths == null) {
    internalOpen.value = !internalOpen.value
  }
}

/** 高亮片段：matched 为 true 表示该片段命中关键字 */
interface HighlightSegment {
  text: string
  matched: boolean
}

/**
 * 将文本按关键字切分为高亮片段数组（不区分大小写）
 * 关键字为空时返回单个未命中片段
 */
function highlight(text: string, keyword: string): HighlightSegment[] {
  if (!keyword) {
    return [{ text, matched: false }]
  }
  const lowerText = text.toLowerCase()
  const lowerKeyword = keyword.toLowerCase()
  const result: HighlightSegment[] = []
  let pos = 0
  while (pos < text.length) {
    const idx = lowerText.indexOf(lowerKeyword, pos)
    if (idx === -1) {
      result.push({ text: text.slice(pos), matched: false })
      break
    }
    if (idx > pos) {
      result.push({ text: text.slice(pos, idx), matched: false })
    }
    result.push({ text: text.slice(idx, idx + keyword.length), matched: true })
    pos = idx + keyword.length
  }
  return result
}

// 节点 key 的显示文本（带引号，参考 JsonNode 风格）
const keyText = computed<string>(() => `"${props.node.key}"`)

// 节点 key 的高亮片段
const highlightedKey = computed<HighlightSegment[]>(() => {
  return highlight(keyText.value, props.searchKeyword ?? '')
})

// 节点 value 的显示文本
const valueText = computed<string>(() => {
  const v = props.node.value
  if (v === null) return 'null'
  if (props.node.valueType === 'string') return `"${String(v)}"`
  return String(v)
})

// 节点 value 的高亮片段
const highlightedValue = computed<HighlightSegment[]>(() => {
  return highlight(valueText.value, props.searchKeyword ?? '')
})

// value 的 CSS 类名（按类型着色）
const valueClass = computed<string>(() => {
  switch (props.node.valueType) {
    case 'string':
      return 'value-string'
    case 'number':
      return 'value-number'
    case 'boolean':
      return 'value-boolean'
    case 'null':
      return 'value-null'
    default:
      return 'value-string'
  }
})

// 子节点数量
const childCount = computed<number>(() => props.node.children?.length ?? 0)
</script>

<template>
  <div class="tree-node">
    <!-- 根节点直接渲染 children -->
    <template v-if="isRoot">
      <div class="children">
        <TreeNode
          v-for="child in node.children"
          :key="child.key"
          :node="child"
          :depth="depth + 1"
          :search-keyword="searchKeyword"
          :expanded-depths="expandedDepths"
        />
      </div>
    </template>
    <template v-else>
      <!-- 节点行 -->
      <div class="node-row">
        <span v-if="!node.isLeaf" class="toggle" @click="toggle">{{ isOpen ? '▾' : '▸' }}</span>
        <span v-else class="toggle-placeholder"></span>
        <span class="key">
          <template v-for="(seg, i) in highlightedKey" :key="i">
            <mark v-if="seg.matched">{{ seg.text }}</mark>
            <template v-else>{{ seg.text }}</template>
          </template>
        </span>
        <span v-if="!node.isLeaf" class="count">{{ childCount }} 项</span>
        <template v-else>
          <span class="punct">: </span>
          <span :class="valueClass">
            <template v-for="(seg, i) in highlightedValue" :key="i">
              <mark v-if="seg.matched">{{ seg.text }}</mark>
              <template v-else>{{ seg.text }}</template>
            </template>
          </span>
        </template>
      </div>
      <!-- 子节点递归渲染 -->
      <div v-if="!node.isLeaf && isOpen" class="children">
        <TreeNode
          v-for="child in node.children"
          :key="child.key"
          :node="child"
          :depth="depth + 1"
          :search-keyword="searchKeyword"
          :expanded-depths="expandedDepths"
        />
      </div>
    </template>
  </div>
</template>

<style scoped>
.tree-node {
  padding-left: 1.2em;
}
.node-row {
  display: flex;
  align-items: center;
  gap: 0.2em;
  padding: 1px 0;
}
.toggle {
  cursor: pointer;
  user-select: none;
  min-width: 1em;
}
.toggle-placeholder {
  min-width: 1em;
}
.key {
  color: #93c5fd;
}
.punct {
  color: #d4d4d4;
}
.count {
  color: #6b7280;
  font-size: 0.85em;
  margin-left: 0.3em;
}
.children {
  border-left: 1px dashed #333;
  margin-left: 0.4em;
}
.value-string {
  color: #86efac;
}
.value-number {
  color: #fdba74;
}
.value-boolean {
  color: #c4b5fd;
}
.value-null {
  color: #9ca3af;
}
mark {
  background: #fbbf24;
  color: #000;
  padding: 0 2px;
  border-radius: 2px;
}
</style>
