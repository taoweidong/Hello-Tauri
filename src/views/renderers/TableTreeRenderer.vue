<script setup lang="ts">
/**
 * 表格+树形联动渲染器
 * 用于 sample_table_tree.csv 类型文件：左侧表格，点击行后右侧展示树形结构数据
 * 业务规则：一种类型 = 一个解析 TS + 一个展示 Vue
 */
import CsvTableTreeView from '@/components/shared/CsvTableTreeView.vue'
import type { CsvData } from '@/types'

defineProps<{ content: CsvData }>()
</script>

<template>
  <CsvTableTreeView :content="content" export-filename="table-tree-data" />
</template>
