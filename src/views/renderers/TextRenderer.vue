<script setup lang="ts">
/**
 * 纯文本渲染器
 * 以行号 + 内容形式展示文本文件，支持行点击定位光标、大文件截断保护
 */
import { NEmpty } from 'naive-ui'
import { useTabManager } from '@/composables/use-tabs'

/** 大文件显示行数上限，超出后截断以防止渲染卡死 */
const MAX_VISIBLE_LINES = 10000

defineProps<{ content: string }>()
const { setCursor, globalFontSize } = useTabManager()

/** 处理行点击事件，计算并更新光标位置 */
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
  <div v-else class="text-renderer" :style="{ fontSize: `${globalFontSize}px` }">
    <template v-for="(line, i) in content.split('\n').slice(0, MAX_VISIBLE_LINES)" :key="i">
      <div class="line" @click="handleLineClick(i, $event)">
        <span class="line-no">{{ i + 1 }}</span>
        <span class="line-text">{{ line }}</span>
      </div>
    </template>
    <div v-if="content.split('\n').length > MAX_VISIBLE_LINES" class="truncated-notice">
      … 仅显示前 {{ MAX_VISIBLE_LINES }} 行，共 {{ content.split('\n').length }} 行
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
  background: var(--color-editor-bg);
  color: var(--color-editor-text);
}
.line { display: flex; }
.line-no {
  color: var(--color-editor-gutter);
  min-width: 3em;
  text-align: right;
  padding-right: 1em;
  user-select: none;
}
.line-text { white-space: pre; }
.truncated-notice {
  color: var(--color-editor-gutter);
  text-align: center;
  padding: 12px;
  font-style: italic;
}
</style>
