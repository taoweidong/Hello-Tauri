<script setup lang="ts">
import { NEmpty } from 'naive-ui'

defineProps<{ content: string }>()
</script>

<template>
  <NEmpty v-if="!content" description="空文件" style="margin-top: 40px;" />
  <div v-else class="text-renderer">
    <div v-for="(line, i) in content.split('\n')" :key="i" class="line">
      <span class="line-no">{{ i + 1 }}</span>
      <span class="line-text">{{ line }}</span>
    </div>
  </div>
</template>

<style scoped>
.text-renderer {
  font-family: "JetBrains Mono", "Fira Code", monospace;
  font-size: 14px;
  white-space: pre;
  overflow: auto;
  height: 100%;
  padding: 8px;
  background: #1a1a2e;
  color: #d4d4d4;
}
.line { display: flex; }
.line-no {
  color: #666;
  min-width: 3em;
  text-align: right;
  padding-right: 1em;
  user-select: none;
}
.line-text { white-space: pre; }
</style>
