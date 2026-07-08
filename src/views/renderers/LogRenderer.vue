<script setup lang="ts">
import { h } from 'vue'
import { NEmpty } from 'naive-ui'
import type { DataTableColumns } from 'naive-ui'
import type { LogLine, LogLevel } from '@/plugins/parsers/types'
import { useTabManager } from '@/composables/use-tabs'
import DataTable from '@/components/shared/DataTable.vue'

const props = defineProps<{ content: LogLine[] }>()
const { setCursor, globalFontSize } = useTabManager()

/** 日志级别对应的颜色映射 */
const levelColor: Record<LogLevel, string> = {
  INFO: '#3B82F6',
  WARN: '#F59E0B',
  ERROR: '#EF4444',
  DEBUG: '#9ca3af',
  OTHER: '#d4d4d4',
}

/** 日志表格列定义 */
const logColumns: DataTableColumns<LogLine> = [
  {
    title: '#',
    key: 'lineNumber',
    width: 70,
    sorter: (a: LogLine, b: LogLine) => a.lineNumber - b.lineNumber,
  },
  {
    title: '时间',
    key: 'timestamp',
    width: 180,
    sorter: 'default',
  },
  {
    title: '级别',
    key: 'level',
    width: 80,
    render: (row: LogLine) =>
      h('span', { style: { color: levelColor[row.level], fontWeight: 600 } }, row.level),
    filterOptions: ['INFO', 'WARN', 'ERROR', 'DEBUG', 'OTHER'].map(v => ({
      label: v,
      value: v,
    })),
    filter: (value: any, row: LogLine) => row.level === value,
  },
  {
    title: '模块',
    key: 'module',
    width: 120,
    sorter: 'default',
  },
  {
    title: '消息',
    key: 'message',
    ellipsis: { tooltip: true },
    render: (row: LogLine) => (row.level === 'OTHER' ? row.raw : row.message),
  },
]
</script>

<template>
  <NEmpty
    v-if="content.length === 0"
    description="空日志"
    style="margin-top: 40px;"
  />
  <DataTable
    v-else
    :columns="logColumns"
    :data="content"
    :exportable="true"
    export-filename="log-data"
    :font-size="globalFontSize"
    :on-row-click="(row: LogLine) => setCursor(row.lineNumber, 1)"
  />
</template>
