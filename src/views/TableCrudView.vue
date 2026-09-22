<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { Delete, Plus, RefreshLeft, Search } from '@element-plus/icons-vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import type { FormInstance, FormRules } from 'element-plus'

import { useAppStore } from '@/stores/app'
import { CATEGORIES, useTableStore } from '@/stores/table'
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

onMounted(() => {
  tableStore.pageSize = appStore.settings.pageSize
})

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
      ElMessage.success('新增成功')
    } else {
      tableStore.update(editingId.value, payload)
      ElMessage.success('保存成功')
    }
    dialogVisible.value = false
  } finally {
    submitting.value = false
  }
}

async function removeOne(row: TableRow) {
  const confirmed = await ElMessageBox.confirm(`确认删除「${row.name}」？`, '删除确认', {
    type: 'warning',
    confirmButtonText: '删除',
    cancelButtonText: '取消',
  }).catch(() => false)
  if (confirmed === false) return
  tableStore.remove([row.id])
  ElMessage.success('已删除')
}

async function removeSelected() {
  if (!selectedRows.value.length) {
    ElMessage.warning('请先选择要删除的记录')
    return
  }
  const confirmed = await ElMessageBox.confirm(
    `确认删除选中的 ${selectedRows.value.length} 条记录？`,
    '批量删除',
    { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' },
  ).catch(() => false)
  if (confirmed === false) return
  tableStore.remove(selectedRows.value.map((row) => row.id))
  selectedRows.value = []
  ElMessage.success('已删除')
}

async function resetData() {
  const confirmed = await ElMessageBox.confirm('将恢复为初始示例数据，当前修改会丢失。', '恢复示例数据', {
    type: 'warning',
    confirmButtonText: '恢复',
    cancelButtonText: '取消',
  }).catch(() => false)
  if (confirmed === false) return
  tableStore.resetSeed()
  selectedRows.value = []
  ElMessage.success('已恢复示例数据')
}

function onSelectionChange(rows: TableRow[]) {
  selectedRows.value = rows
}

function onSearch() {
  tableStore.page = 1
}
</script>

<template>
  <div class="page">
    <el-card shadow="never">
      <template #header>
        <div class="page-toolbar">
          <el-input
            v-model="tableStore.keyword"
            class="page-toolbar__search"
            placeholder="搜索名称或负责人"
            clearable
            :prefix-icon="Search"
            @keyup.enter="onSearch"
          />
          <el-select v-model="tableStore.category" class="page-toolbar__select" placeholder="全部分类" clearable>
            <el-option v-for="item in CATEGORIES" :key="item" :label="item" :value="item" />
          </el-select>
          <div class="page-toolbar__spacer" />
          <el-button type="primary" :icon="Plus" @click="openCreate">新增</el-button>
          <el-button type="danger" plain :icon="Delete" :disabled="!selectedRows.length" @click="removeSelected">
            批量删除
          </el-button>
          <el-button :icon="RefreshLeft" @click="resetData">恢复示例</el-button>
        </div>
      </template>

      <el-table
        :data="tableStore.paged"
        stripe
        border
        row-key="id"
        @selection-change="onSelectionChange"
      >
        <el-table-column type="selection" width="44" />
        <el-table-column prop="id" label="编号" width="80" sortable />
        <el-table-column prop="name" label="名称" min-width="130" show-overflow-tooltip />
        <el-table-column prop="category" label="分类" width="96" />
        <el-table-column prop="owner" label="负责人" width="84" />
        <el-table-column label="状态" width="72">
          <template #default="{ row }">
            <el-tag size="small" :type="row.status === 'active' ? 'success' : 'info'">
              {{ statusText[row.status] }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="amount" label="金额（元）" width="124" align="right" sortable>
          <template #default="{ row }">{{ row.amount.toLocaleString('zh-CN') }}</template>
        </el-table-column>
        <el-table-column prop="createdAt" label="创建日期" width="100" />
        <el-table-column label="操作" width="140" fixed="right">
          <template #default="{ row }">
            <el-button text type="primary" size="small" @click="openEdit(row)">编辑</el-button>
            <el-button text type="danger" size="small" @click="removeOne(row)">删除</el-button>
          </template>
        </el-table-column>
        <template #empty>
          <el-empty description="暂无数据" />
        </template>
      </el-table>

      <div class="table-footer">
        <span class="text-muted">
          共 {{ tableStore.total }} 条，已选 {{ selectedRows.length }} 条
        </span>
        <el-pagination
          v-model:current-page="tableStore.page"
          v-model:page-size="tableStore.pageSize"
          :page-sizes="[5, 10, 20, 50]"
          :total="tableStore.total"
          layout="sizes, prev, pager, next, jumper"
          background
        />
      </div>
    </el-card>

    <el-dialog v-model="dialogVisible" :title="dialogTitle" width="520px" append-to-body destroy-on-close>
      <el-form ref="formRef" :model="draft" :rules="rules" label-width="88px" status-icon>
        <el-form-item label="名称" prop="name">
          <el-input v-model="draft.name" placeholder="请输入名称" maxlength="30" show-word-limit />
        </el-form-item>
        <el-form-item label="分类" prop="category">
          <el-select v-model="draft.category" placeholder="请选择分类">
            <el-option v-for="item in CATEGORIES" :key="item" :label="item" :value="item" />
          </el-select>
        </el-form-item>
        <el-form-item label="负责人" prop="owner">
          <el-input v-model="draft.owner" placeholder="请输入负责人" maxlength="20" />
        </el-form-item>
        <el-form-item label="状态" prop="status">
          <el-radio-group v-model="draft.status">
            <el-radio value="active">启用</el-radio>
            <el-radio value="inactive">停用</el-radio>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="金额" prop="amount">
          <el-input-number v-model="draft.amount" :min="0" :max="9999999" :step="100" controls-position="right" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="submitting" @click="submit">确定</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.page-toolbar__search {
  width: 240px;
}

.page-toolbar__select {
  width: 160px;
}

.table-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-top: 14px;
  flex-wrap: wrap;
}
</style>
