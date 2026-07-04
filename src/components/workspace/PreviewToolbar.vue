<script setup lang="ts">
import { NInputNumber, NSwitch, NSelect, NSpace, NText } from 'naive-ui'

defineProps<{
  type: 'text' | 'csv' | 'json' | 'hex' | 'log'
}>()

const fontSize = defineModel<number>('fontSize', { default: 14 })
const wrap = defineModel<boolean>('wrap', { default: false })
const showLineNumbers = defineModel<boolean>('showLineNumbers', { default: true })

const encodingOptions = [
  { label: 'UTF-8', value: 'utf-8' },
  { label: 'GBK', value: 'gbk' },
  { label: 'Shift_JIS', value: 'shift_jis' },
]
const encoding = defineModel<string>('encoding', { default: 'utf-8' })
</script>

<template>
  <NSpace align="center" :size="12" class="preview-toolbar">
    <NSpace align="center" :size="4">
      <NText depth="3" style="font-size: 12px;">字号</NText>
      <NInputNumber v-model:value="fontSize" :min="10" :max="24" size="small" style="width: 70px;" />
    </NSpace>

    <template v-if="type === 'text' || type === 'hex'">
      <NSpace align="center" :size="4">
        <NText depth="3" style="font-size: 12px;">换行</NText>
        <NSwitch v-model:value="wrap" size="small" />
      </NSpace>
      <NSpace align="center" :size="4">
        <NText depth="3" style="font-size: 12px;">行号</NText>
        <NSwitch v-model:value="showLineNumbers" size="small" />
      </NSpace>
    </template>

    <NSpace align="center" :size="4">
      <NText depth="3" style="font-size: 12px;">编码</NText>
      <NSelect v-model:value="encoding" :options="encodingOptions" size="small" style="width: 100px;" />
    </NSpace>
  </NSpace>
</template>

<style scoped>
.preview-toolbar {
  padding: 4px 8px;
  border-bottom: 1px solid var(--border, #333);
  background: var(--bg-surface, transparent);
}
</style>
