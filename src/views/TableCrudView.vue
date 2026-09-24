<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import type { FormInstance, FormRules } from 'element-plus'
import { IconSearch, IconPlus, IconTrash, IconRestore, IconX } from '@/components/icons'

import { CATEGORIES, useTableStore } from '@/stores/table'
import { useAppStore } from '@/stores/app'
import type { TableRow, TableRowDraft } from '@/types'

const appStore = useAppStore()
const tableStore = useTableStore()

const dialogVisible = ref(false)
const editingId = ref<number | null>(null)
const submitting = ref(false)
const selectedRows = ref<TableRow[]>([])
const formRef = ref<FormInstance>()

const draft = reactive<TableRowDraft>({
  name: '',
  category: CATEGORIES[0],
  status: 'active',
  amount: 0,
  owner: '',
})

const rules: FormRules<TableRowDraft> = {
  name: [
    { required: true, message: '请输入名称', trigger: 'blur' },
    { min: 2, max: 30, message: '长度应在 2 到 30 个字符', trigger: 'blur' },
  ],
  category: [{ required: true, message: '请选择分类', trigger: 'change' }],
  owner: [{ required: true, message: '请输入负责人', trigger: 'blur' }],
  amount: [{ required: true, type: 'number', message: '请输入金额', trigger: 'change' }],
}

const dialogTitle = computed(() => (editingId.value === null ? '新增记录' : '编辑记录'))
const statusText: Record<string, string> = { active: '启用', inactive: '停用' }
const catIndex = (name: string) => Math.max(0, CATEGORIES.indexOf(name))
const filtering = computed(() => Boolean(tableStore.keyword || tableStore.category))

function fmt(n: number) {
  return n.toLocaleString('zh-CN')
}

function resetDraft() {
  draft.name = ''
  draft.category = CATEGORIES[0]
  draft.status = 'active'
  draft.amount = 0
  draft.owner = ''
  formRef.value?.clearValidate()
}

function openCreate() {
  editingId.value = null
  resetDraft()
  dialogVisible.value = true
}

function openEdit(row: TableRow) {
  editingId.value = row.id
  draft.name = row.name
  draft.category = row.category
  draft.status = row.status
  draft.amount = row.amount
  draft.owner = row.owner
  formRef.value?.clearValidate()
  dialogVisible.value = true
}

async function submit() {
  const form = formRef.value
  if (!form) return
  const valid = await form.validate().catch(() => false)
  if (!valid) return

  submitting.value = true
  try {
    const payload: TableRowDraft = {
      name: draft.name.trim(),
      category: draft.category,
      status: draft.status,
      amount: draft.amount,
      owner: draft.owner.trim(),
    }
    if (editingId.value === null) {
      tableStore.create(payload)
      ElMessage({ message: '已新增记录', type: 'success' })
    } else {
      tableStore.update(editingId.value, payload)
      ElMessage({ message: '已保存修改', type: 'success' })
    }
    dialogVisible.value = false
  } finally {
    submitting.value = false
  }
}

async function removeOne(row: TableRow) {
  const confirmed = await ElMessageBox.confirm(
    `「${row.name}」将被删除，此操作不可撤销。`,
    '删除记录',
    { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消', confirmButtonClass: 'el-button--danger' },
  ).catch(() => false)
  if (confirmed === false) return
  tableStore.remove([row.id])
  ElMessage({ message: '已删除', type: 'success' })
}

async function removeSelected() {
  if (!selectedRows.value.length) {
    ElMessage.warning('请先勾选要删除的记录')
    return
  }
  const confirmed = await ElMessageBox.confirm(
    `已选 ${selectedRows.value.length} 条记录，删除后不可撤销。`,
    '批量删除',
    { type: 'warning', confirmButtonText: `删除 ${selectedRows.value.length} 条`, cancelButtonText: '取消', confirmButtonClass: 'el-button--danger' },
  ).catch(() => false)
  if (confirmed === false) return
  tableStore.remove(selectedRows.value.map((row) => row.id))
  selectedRows.value = []
  ElMessage({ message: '已删除', type: 'success' })
}

async function resetData() {
  const confirmed = await ElMessageBox.confirm(
    '将恢复为初始示例数据，当前修改会全部丢失。',
    '恢复示例数据',
    { type: 'warning', confirmButtonText: '恢复', cancelButtonText: '取消' },
  ).catch(() => false)
  if (confirmed === false) return
  tableStore.resetSeed()
  selectedRows.value = []
  ElMessage({ message: '已恢复示例数据', type: 'success' })
}

function onSelectionChange(rows: TableRow[]) {
  selectedRows.value = rows
}

function clearFilters() {
  tableStore.keyword = ''
  tableStore.category = ''
}

/** 分页器改变每页条数时写回配置源（单一真值），自动保存负责落盘 */
function onPageSizeChange(size: number) {
  appStore.settings.pageSize = size
  tableStore.page = 1
}
</script>

<template>
  <div class="page">
    <div class="page-title">
      <h1>数据管理</h1>
      <span class="caption">业务记录的检索与维护</span>
    </div>

    <section class="ht-card">
      <!-- 工具栏 -->
      <header class="toolbar">
        <el-input
          v-model="tableStore.keyword"
          class="toolbar__search"
          placeholder="搜索名称或负责人"
          clearable
          :prefix-icon="IconSearch"
        />
        <el-select v-model="tableStore.category" class="toolbar__select" placeholder="全部分类" clearable>
          <el-option v-for="(item, i) in CATEGORIES" :key="item" :label="item" :value="item">
            <span class="dot" :class="`dot--${i}`" /> {{ item }}
          </el-option>
        </el-select>
        <button v-if="filtering" class="toolbar__clear pressable" @click="clearFilters">
          <IconX class="toolbar__clear-icon" /> 清除筛选
        </button>
        <div class="toolbar__spacer" />
        <el-button :icon="IconRestore" @click="resetData">恢复示例</el-button>
        <el-button :disabled="!selectedRows.length" :icon="IconTrash" @click="removeSelected">
          批量删除<template v-if="selectedRows.length">（{{ selectedRows.length }}）</template>
        </el-button>
        <el-button type="primary" :icon="IconPlus" @click="openCreate">新增</el-button>
      </header>

      <!-- 表格 -->
      <el-table
        :data="tableStore.paged"
        row-key="id"
        :row-class-name="({ row }: any) => (row.status === 'inactive' ? 'row--dim' : '')"
        @selection-change="onSelectionChange"
      >
        <el-table-column type="selection" width="40" />
        <el-table-column prop="id" label="编号" width="76" sortable>
          <template #default="{ row }"><span class="num muted">#{{ row.id }}</span></template>
        </el-table-column>
        <el-table-column prop="name" label="名称" min-width="150" show-overflow-tooltip>
          <template #default="{ row }">
            <span class="dot" :class="`dot--${catIndex(row.category)}`" aria-hidden="true" />
            <span class="cell-name">{{ row.name }}</span>
          </template>
        </el-table-column>
        <el-table-column prop="category" label="分类" width="104">
          <template #default="{ row }"><span class="cell2">{{ row.category }}</span></template>
        </el-table-column>
        <el-table-column prop="owner" label="负责人" width="92">
          <template #default="{ row }"><span class="cell2">{{ row.owner }}</span></template>
        </el-table-column>
        <el-table-column label="状态" width="84">
          <template #default="{ row }">
            <span class="pill" :class="{ 'pill--ok': row.status === 'active' }">{{ statusText[row.status] }}</span>
          </template>
        </el-table-column>
        <el-table-column prop="amount" label="金额（元）" width="128" align="right" sortable>
          <template #default="{ row }"><span class="num">{{ fmt(row.amount) }}</span></template>
        </el-table-column>
        <el-table-column prop="createdAt" label="创建日期" width="104">
          <template #default="{ row }"><span class="num cell2">{{ row.createdAt }}</span></template>
        </el-table-column>
        <el-table-column label="" width="104" align="right" fixed="right">
          <template #default="{ row }">
            <span class="actions">
              <button class="act pressable" @click="openEdit(row)">编辑</button>
              <button class="act act--danger pressable" @click="removeOne(row)">删除</button>
            </span>
          </template>
        </el-table-column>
        <template #empty>
          <div class="empty">
            <IconSearch class="empty__icon" />
            <p>{{ filtering ? '没有匹配的记录' : '暂无数据' }}</p>
            <button v-if="filtering" class="empty__clear" @click="clearFilters">清除筛选条件</button>
            <button v-else class="empty__clear" @click="openCreate">新增第一条记录</button>
          </div>
        </template>
      </el-table>

      <!-- 分页脚 -->
      <footer class="pager">
        <span class="pager__meta num">
          {{ tableStore.total ? (tableStore.page - 1) * tableStore.pageSize + 1 : 0 }}–{{ Math.min(tableStore.page * tableStore.pageSize, tableStore.total) }} / {{ tableStore.total }}
        </span>
        <el-pagination
          v-model:current-page="tableStore.page"
          :page-size="tableStore.pageSize"
          :page-sizes="[5, 10, 20, 50]"
          :total="tableStore.total"
          layout="sizes, prev, pager, next"
          size="small"
          background
          @size-change="onPageSizeChange"
        />
      </footer>
    </section>

    <!-- 新增/编辑对话框 -->
    <el-dialog v-model="dialogVisible" :title="dialogTitle" width="480px" append-to-body destroy-on-close>
      <el-form ref="formRef" :model="draft" :rules="rules" label-width="72px" status-icon @submit.prevent>
        <el-form-item label="名称" prop="name">
          <el-input v-model="draft.name" placeholder="记录名称" maxlength="30" show-word-limit />
        </el-form-item>
        <el-form-item label="分类" prop="category">
          <el-select v-model="draft.category" placeholder="请选择分类">
            <el-option v-for="(item, i) in CATEGORIES" :key="item" :label="item" :value="item">
              <span class="dot" :class="`dot--${i}`" /> {{ item }}
            </el-option>
          </el-select>
        </el-form-item>
        <el-form-item label="负责人" prop="owner">
          <el-input v-model="draft.owner" placeholder="负责人姓名" maxlength="20" />
        </el-form-item>
        <el-form-item label="状态" prop="status">
          <el-radio-group v-model="draft.status">
            <el-radio value="active">启用</el-radio>
            <el-radio value="inactive">停用</el-radio>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="金额" prop="amount">
          <el-input-number v-model="draft.amount" :min="0" :max="9999999" :step="100" controls-position="right" class="form__amount" />
          <span class="form__unit">元</span>
        </el-form-item>
      </el-form>
      <template #footer>
        <div class="dialog-foot">
          <el-button @click="dialogVisible = false">取消</el-button>
          <el-button type="primary" :loading="submitting" @click="submit">
            {{ editingId === null ? '创建记录' : '保存修改' }}
          </el-button>
        </div>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
/* —— 工具栏 —— */
.toolbar {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  padding: 12px 16px;
  border-bottom: 1px solid var(--ht-line);
}

.toolbar__search {
  width: 230px;
}

.toolbar__select {
  width: 150px;
}

.toolbar__clear {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  border: none;
  background: var(--ht-primary-soft);
  color: var(--ht-primary);
  padding: 4px 10px;
  border-radius: 999px;
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}

.toolbar__clear:hover {
  background: var(--ht-primary-line);
}

.toolbar__clear-icon {
  width: 11px;
  height: 11px;
}

.toolbar__spacer {
  flex: 1;
}

/* —— 表格 —— */
:deep(.row--dim .cell-name) {
  color: var(--ht-text-3);
}

.cell-name {
  color: var(--ht-text-1);
}

.cell2 {
  font-size: 12.5px;
  color: var(--ht-text-2);
}

.muted {
  color: var(--ht-text-3);
}

.dot {
  margin-right: 7px;
  vertical-align: 1px;
}

:deep(.el-table__cell) {
  padding: 9px 0;
}

/* 行操作：hover 行时才提亮（渐进披露） */
.actions {
  display: inline-flex;
  gap: 2px;
  opacity: 0.55;
  transition: opacity 0.15s ease;
}

:deep(.el-table__row:hover) .actions,
.actions:focus-within {
  opacity: 1;
}

.act {
  border: none;
  background: none;
  padding: 3px 7px;
  border-radius: 6px;
  font: inherit;
  font-size: 12.5px;
  color: var(--ht-text-2);
  cursor: pointer;
}

.act:hover {
  background: var(--ht-primary-soft);
  color: var(--ht-primary);
}

.act--danger:hover {
  background: #f7e9e9;
  color: var(--ht-danger);
}

html.dark .act--danger:hover {
  background: #30201f;
}

/* —— 分页脚 —— */
.pager {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 16px;
  border-top: 1px solid var(--ht-line);
  flex-wrap: wrap;
}

.pager__meta {
  font-size: 12px;
  color: var(--ht-text-3);
}

/* —— 空状态 —— */
.empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  padding: 34px 0 36px;
  color: var(--ht-text-3);
}

.empty p {
  margin: 6px 0 8px;
  font-size: 13px;
}

.empty__icon {
  width: 26px;
  height: 26px;
  opacity: 0.5;
}

.empty__clear {
  border: 1px solid var(--ht-line);
  background: var(--ht-surface);
  padding: 5px 12px;
  border-radius: 7px;
  font: inherit;
  font-size: 12.5px;
  color: var(--ht-text-2);
  cursor: pointer;
}

.empty__clear:hover {
  border-color: var(--ht-primary-line);
  color: var(--ht-primary);
  background: var(--ht-primary-soft);
}

/* —— 对话框 —— */
.form__amount {
  width: 180px;
}

.form__unit {
  margin-left: 10px;
  font-size: 12px;
  color: var(--ht-text-3);
}

.dialog-foot {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
</style>