<script setup lang="ts">
import { ref } from 'vue'

const props = withDefaults(defineProps<{
  node: unknown
  name?: string
  defaultOpen?: boolean
  depth?: number
}>(), {
  depth: 0,
})

/** 深层嵌套默认折叠：depth > 3 时默认关闭 */
const open = ref(props.defaultOpen ?? (props.depth <= 3))

/** 切换节点展开/折叠状态 */
function toggle() {
  open.value = !open.value
}

/** 判断值的 JSON 类型 */
function typeOf(v: unknown): 'array' | 'object' | 'string' | 'number' | 'boolean' | 'null' | 'other' {
  if (v === null) return 'null'
  if (Array.isArray(v)) return 'array'
  const t = typeof v
  if (t === 'string' || t === 'number' || t === 'boolean') return t
  if (t === 'object') return 'object'
  return 'other'
}

/** 获取对象/数组的键值对列表 */
function entries(v: object): Array<readonly [string, unknown]> {
  if (Array.isArray(v)) return v.map((val, i) => [String(i), val] as const)
  return Object.entries(v).map(([k, val]) => [k, val] as const)
}

/** 获取对象/数组的子项数量 */
function count(v: unknown): number {
  if (Array.isArray(v)) return v.length
  if (v && typeof v === 'object') return Object.keys(v).length
  return 0
}
</script>

<template>
  <div class="json-node">
    <span v-if="name !== undefined" class="json-key">"{{ name }}"</span>
    <span v-if="name !== undefined" class="json-punct">: </span>
    <span v-if="typeOf(node) === 'array'" class="json-punct">[</span>
    <span v-else-if="typeOf(node) === 'object'" class="json-punct">{</span>
    <span
      v-if="typeOf(node) === 'array' || typeOf(node) === 'object'"
      class="toggle"
      @click="toggle"
    >{{ open ? '▾' : '▸' }}</span>
    <span
      v-if="typeOf(node) === 'array' || typeOf(node) === 'object'"
      class="json-count"
    >{{ count(node) }} 项</span>
    <div
      v-if="(typeOf(node) === 'array' || typeOf(node) === 'object') && open"
      class="children"
    >
      <JsonNode
        v-for="[k, v] in entries(node as object)"
        :key="k"
        :name="k"
        :node="v"
        :default-open="defaultOpen"
        :depth="depth + 1"
      />
    </div>
    <span
      v-if="(typeOf(node) === 'array' || typeOf(node) === 'object') && !open"
      class="json-punct"
    >...</span>
    <span v-if="typeOf(node) === 'array'" class="json-punct">]</span>
    <span v-else-if="typeOf(node) === 'object'" class="json-punct">}</span>
    <span v-else-if="typeOf(node) === 'string'" class="json-string">"{{ node }}"</span>
    <span v-else-if="typeOf(node) === 'number'" class="json-number">{{ node }}</span>
    <span v-else-if="typeOf(node) === 'boolean'" class="json-boolean">{{ node }}</span>
    <span v-else-if="typeOf(node) === 'null'" class="json-null">null</span>
  </div>
</template>

<style scoped>
.json-node { padding-left: 1.2em; }
.json-key { color: var(--color-json-key); }
.json-string { color: var(--color-json-string); }
.json-number { color: var(--color-json-number); }
.json-boolean { color: var(--color-json-boolean); }
.json-null { color: var(--color-json-null); }
.json-punct { color: var(--color-json-punct); }
.json-count { color: var(--color-json-count); font-size: 0.85em; margin-left: 0.3em; }
.toggle { cursor: pointer; user-select: none; margin: 0 0.2em; }
.children { border-left: 1px dashed var(--color-json-border); margin-left: 0.4em; }
</style>
