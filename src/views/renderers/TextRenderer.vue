<script setup lang="ts">
import { NEmpty } from 'naive-ui'
import { useTabManager } from '@/composables/use-tabs'

defineProps<{ content: string }>()
const { setCursor } = useTabManager()

function handleLineClick(lineIndex: number, event: MouseEvent) {
  const target = event.currentTarget as HTMLElement
  if (!target) return
  // 计算列号：根据点击位置相对于文本起始的偏移
  const rect = target.getBoundingClientRect()
  const charWidth = 8.4 // 等宽字体近似字符宽度
  const col = Math.max(1, Math.round((event.clientX - rect.left) / charWidth) + 1)
  setCursor(lineIndex + 1, col)
}
</script>

<template>
  <NEmpty v-if="!content" description="空文件" style="margin-top: 40px;" />
  <div v-else class="text-renderer">
    <div v-for="(line, i) in content.split('\n')" :key="i" class="line" @click="handleLineClick(i, $event)">
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
