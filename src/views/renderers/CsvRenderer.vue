<script setup lang="ts">
/**
 * CSV 表格渲染器
 * 用于 sample.csv 类型文件：表格展示，点击行后可查看树形结构数据
 * 业务规则：一种类型 = 一个解析 TS + 一个展示 Vue
 */
import CsvTableTreeView from '@/components/shared/CsvTableTreeView.vue'
import type { CsvData } from '@/types'

defineProps<{ content: CsvData }>()
</script>

<template>
  <CsvTableTreeView :content="content" export-filename="csv-data" />
</template>
