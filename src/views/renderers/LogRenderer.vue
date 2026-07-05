<script setup lang="ts">
import { NEmpty } from 'naive-ui'
import type { LogLine, LogLevel } from '@/plugins/parsers/types'
import { useTabManager } from '@/composables/use-tabs'

defineProps<{ content: LogLine[] }>()
const { setCursor } = useTabManager()

const levelColor: Record<LogLevel, string> = {
  INFO: '#3B82F6',
  WARN: '#F59E0B',
  ERROR: '#EF4444',
  DEBUG: '#9ca3af',
  OTHER: '#d4d4d4',
}

function handleLineClick(lineNumber: number) {
  setCursor(lineNumber, 1)
}
</script>

<template>
  <NEmpty v-if="content.length === 0" description="空日志" style="margin-top: 40px;" />
  <div v-else class="log-renderer">
    <div v-for="line in content" :key="line.lineNumber" class="log-line" @click="handleLineClick(line.lineNumber)">
      <span class="col-no">{{ line.lineNumber }}</span>
      <span class="col-ts">{{ line.timestamp }}</span>
      <span class="col-level" :style="{ color: levelColor[line.level] }">{{ line.level }}</span>
      <span class="col-mod">{{ line.module }}</span>
      <span v-if="line.level === 'OTHER'" class="col-msg">{{ line.raw }}</span>
      <span v-else class="col-msg">{{ line.message }}</span>
    </div>
  </div>
</template>

<style scoped>
.log-renderer {
  font-family: "JetBrains Mono", monospace;
  font-size: 14px;
  padding: 8px;
  overflow: auto;
  height: 100%;
  background: #1a1a2e;
  color: #d4d4d4;
}
.log-line {
  display: flex;
  gap: 1em;
  padding: 1px 0;
  white-space: pre;
}
.col-no {
  color: #666;
  min-width: 3em;
  text-align: right;
  user-select: none;
}
.col-ts { color: #6b7280; }
.col-level { font-weight: 600; min-width: 5em; }
.col-mod { color: #93c5fd; min-width: 8em; }
.col-msg { flex: 1; }
</style>
