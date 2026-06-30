<script setup lang="ts">
import { ref } from 'vue'

const props = defineProps<{
  node: unknown
  name?: string
  defaultOpen?: boolean
}>()

const open = ref(props.defaultOpen ?? true)

function toggle() {
  open.value = !open.value
}

function typeOf(v: unknown): 'array' | 'object' | 'string' | 'number' | 'boolean' | 'null' | 'other' {
  if (v === null) return 'null'
  if (Array.isArray(v)) return 'array'
  const t = typeof v
  if (t === 'string' || t === 'number' || t === 'boolean') return t
  if (t === 'object') return 'object'
  return 'other'
}

function entries(v: object): Array<readonly [string, unknown]> {
  if (Array.isArray(v)) return v.map((val, i) => [String(i), val] as const)
  return Object.entries(v).map(([k, val]) => [k, val] as const)
}

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
.json-key { color: #93c5fd; }
.json-string { color: #86efac; }
.json-number { color: #fdba74; }
.json-boolean { color: #c4b5fd; }
.json-null { color: #9ca3af; }
.json-punct { color: #d4d4d4; }
.json-count { color: #6b7280; font-size: 0.85em; margin-left: 0.3em; }
.toggle { cursor: pointer; user-select: none; margin: 0 0.2em; }
.children { border-left: 1px dashed #333; margin-left: 0.4em; }
</style>
