<script setup lang="ts">
/**
 * 表格+树形联动渲染器
 * 用于 sample_table_tree.csv 类型文件：左侧表格，点击行后右侧展示树形结构数据
 * 业务规则：一种类型 = 一个解析 TS + 一个展示 Vue
 */
import { NEmpty } from 'naive-ui'
import { useTabManager } from '@/composables/use-tabs'
import { useCsvTableTree } from '@/composables/use-csv-table-tree'
import DataTable from '@/components/shared/DataTable.vue'
import SplitView from '@/components/workspace/SplitView.vue'
import CsvTreeDetail from './CsvTreeDetail.vue'
import type { CsvData } from '@/types'

const props = defineProps<{ content: CsvData }>()
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
  <div v-else-if="selectedIndex === null" class="table-tree-renderer">
    <DataTable
      :columns="columns"
      :data="data"
      :exportable="true"
      export-filename="table-tree-data"
      :font-size="globalFontSize"
      :on-row-click="handleRowClick"
      :row-class-name="rowClassName"
    />
  </div>
  <!-- 分栏模式：选中行后左表格 + 右树形详情 -->
  <div v-else class="table-tree-split-container">
    <SplitView>
      <template #left>
        <div class="table-tree-renderer">
          <DataTable
            :columns="columns"
            :data="data"
            :exportable="true"
            export-filename="table-tree-data"
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
.table-tree-renderer {
  height: 100%;
  overflow: hidden;
}
.table-tree-split-container {
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
