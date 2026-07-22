<script setup lang="ts">
/**
 * CSV 表格+树形联动共享视图组件
 * 统一 CsvRenderer 与 TableTreeRenderer 的展示逻辑，消除重复模板
 */
import { NEmpty } from 'naive-ui'
import { useTabManager } from '@/composables/use-tabs'
import { useCsvTableTree } from '@/composables/use-csv-table-tree'
import DataTable from '@/components/shared/DataTable.vue'
import SplitView from '@/components/workspace/SplitView.vue'
import CsvTreeDetail from '@/views/renderers/CsvTreeDetail.vue'
import type { CsvData } from '@/types'

const props = withDefaults(defineProps<{
  content: CsvData
  /** 导出文件名（不含扩展名） */
  exportFilename?: string
}>(), {
  exportFilename: 'csv-data',
})

const { globalFontSize } = useTabManager()

/** 公共表格+树形联动逻辑 */
const { selectedIndex, selectedTree, columns, data, handleRowClick, handleCloseDetail, rowClassName } =
  useCsvTableTree(() => props.content)
</script>

<template>
  <NEmpty
    v-if="content.headers.length === 0 && content.rows.length === 0"
    description="空表格"
    style="margin-top: 40px;"
  />
  <!-- 单栏模式：未选中行时全宽展示 DataTable -->
  <div v-else-if="selectedIndex === null" class="csv-table-tree-view">
    <DataTable
      :columns="columns"
      :data="data"
      :exportable="true"
      :export-filename="exportFilename"
      :font-size="globalFontSize"
      :on-row-click="handleRowClick"
      :row-class-name="rowClassName"
    />
  </div>
  <!-- 分栏模式：选中行后左表格 + 右树形详情 -->
  <div v-else class="csv-table-tree-split">
    <SplitView>
      <template #left>
        <div class="csv-table-tree-view">
          <DataTable
            :columns="columns"
            :data="data"
            :exportable="true"
            :export-filename="exportFilename"
            :font-size="globalFontSize"
            :on-row-click="handleRowClick"
            :row-class-name="rowClassName"
          />
        </div>
      </template>
      <template #right>
        <CsvTreeDetail
          v-if="selectedTree"
          :tree="selectedTree"
          @close="handleCloseDetail"
        />
      </template>
    </SplitView>
  </div>
</template>

<style scoped>
.csv-table-tree-view {
  height: 100%;
  overflow: hidden;
}
.csv-table-tree-split {
  height: 100%;
  overflow: hidden;
}
/* 选中行高亮：透传到 NDataTable 的 row-class-name，需用 :deep 穿透 */
:deep(.csv-row-selected td) {
  background: var(--color-primary-soft, rgba(59, 130, 246, 0.18)) !important;
  color: var(--color-primary, #60a5fa) !important;
  font-weight: 500;
}
</style>
