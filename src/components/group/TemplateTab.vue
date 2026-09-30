<script setup lang="ts">
/**
 * Tab「建群模板」（migration v3）—— 模板 CRUD。
 *
 * 模板字段刻意精简：模板名（本地标识）、群名称（建群默认值）、成员工号、
 * 说明。成员输入用文本域 + 归一化（`normalizeMemberIds`），与建群表单同一
 * 口径 —— 两处各写一套解析必然漂移。
 */
import { computed, onMounted, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import type { FormInstance, FormRules } from 'element-plus'

import { IconPlus, IconTrash } from '@/components/icons'
import { useGroupStore } from '@/stores/group'
import { normalizeMemberIds } from '@/types/welink'
import type { GroupTemplate } from '@/types/welink'
import { rowOf } from '@/utils/table'
import { shortStamp } from '@/utils/welink-display'

const store = useGroupStore()

const dialogVisible = ref(false)
const editingPk = ref<number | null>(null)
const submitting = ref(false)
const formRef = ref<FormInstance>()

const draft = reactive({ name: '', groupName: '', membersInput: '', description: '' })

/** 归一化后的成员清单（实时计数回显，与提交口径一致） */
const members = computed(() => normalizeMemberIds(draft.membersInput))

const rules: FormRules = {
  name: [
    { required: true, message: '请输入模板名', trigger: 'blur' },
    { max: 30, message: '模板名不能超过 30 字', trigger: 'blur' },
  ],
  groupName: [
    { required: true, message: '请输入群名称', trigger: 'blur' },
    { max: 64, message: '群名称不能超过 64 字', trigger: 'blur' },
  ],
}

const dialogTitle = computed(() => (editingPk.value === null ? '新建模板' : '编辑模板'))

const templateOf = (row: unknown): GroupTemplate => rowOf<GroupTemplate>(row)

/** 成员列的摘要：前 3 个工号 + 「等 N 人」 */
function memberSummary(row: unknown): string {
  const list = templateOf(row).members
  if (!list.length) return '—'
  const head = list.slice(0, 3).join('、')
  return list.length > 3 ? `${head} 等 ${list.length} 人` : head
}

function resetDraft() {
  editingPk.value = null
  draft.name = ''
  draft.groupName = ''
  draft.membersInput = ''
  draft.description = ''
  formRef.value?.clearValidate()
}

function openCreate() {
  resetDraft()
  dialogVisible.value = true
}

function openEdit(row: unknown) {
  const template = templateOf(row)
  editingPk.value = template.pk
  draft.name = template.name
  draft.groupName = template.groupName
  draft.membersInput = template.members.join(', ')
  draft.description = template.description
  formRef.value?.clearValidate()
  dialogVisible.value = true
}

async function submit() {
  const form = formRef.value
  if (!form) return
  const valid = await form.validate().catch(() => false)
  if (!valid) return
  if (!members.value.length) {
    ElMessage.warning('请至少添加一名群成员')
    return
  }

  submitting.value = true
  try {
    await store.saveTemplate(
      {
        name: draft.name.trim(),
        groupName: draft.groupName.trim(),
        members: members.value,
        description: draft.description.trim(),
      },
      editingPk.value ?? undefined,
    )
    ElMessage.success(editingPk.value === null ? '已创建模板' : '已保存修改')
    dialogVisible.value = false
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '保存模板失败')
  } finally {
    submitting.value = false
  }
}

async function remove(row: unknown) {
  const template = templateOf(row)
  const confirmed = await ElMessageBox.confirm(
    `删除模板「${template.name}」？已有的建群历史不受影响（历史保存的是当时的快照）。`,
    '删除模板',
    { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' },
  ).catch(() => false)
  if (confirmed === false) return
  try {
    await store.removeTemplate(template.pk)
    ElMessage.success('已删除模板')
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '删除模板失败')
  }
}

onMounted(() => {
  void store.loadTemplates()
})
</script>

<template>
  <div class="tpl">
    <header class="tpl__toolbar">
      <span class="tpl__hint">模板保存「群名称 + 成员工号」，建群时一键带入、可再修改。</span>
      <div class="tpl__spacer" />
      <el-button type="primary" :icon="IconPlus" @click="openCreate">新建模板</el-button>
    </header>

    <el-table :data="store.templates" class="tpl__table" empty-text="暂无模板，点右上角「新建模板」创建">
      <el-table-column label="模板名" min-width="140">
        <template #default="{ row }">
          <span class="tpl__name">{{ templateOf(row).name }}</span>
        </template>
      </el-table-column>
      <el-table-column label="群名称" prop="groupName" min-width="160" show-overflow-tooltip />
      <el-table-column label="成员" min-width="200" show-overflow-tooltip>
        <template #default="{ row }">{{ memberSummary(row) }}</template>
      </el-table-column>
      <el-table-column label="说明" prop="description" min-width="160" show-overflow-tooltip>
        <template #default="{ row }">{{ templateOf(row).description || '—' }}</template>
      </el-table-column>
      <el-table-column label="更新时间" width="150">
        <template #default="{ row }">{{ shortStamp(templateOf(row).updatedAt) }}</template>
      </el-table-column>
      <el-table-column label="操作" width="130" fixed="right">
        <template #default="{ row }">
          <el-button link type="primary" size="small" @click="openEdit(row)">编辑</el-button>
          <el-button link type="danger" size="small" :icon="IconTrash" @click="remove(row)">删除</el-button>
        </template>
      </el-table-column>
    </el-table>

    <el-dialog v-model="dialogVisible" :title="dialogTitle" width="560px" :close-on-click-modal="false">
      <el-form ref="formRef" :model="draft" label-position="top" :rules="rules" @submit.prevent>
        <el-form-item label="模板名" prop="name">
          <el-input v-model="draft.name" placeholder="如：项目周会群" maxlength="30" show-word-limit />
        </el-form-item>
        <el-form-item label="群名称" prop="groupName">
          <el-input v-model="draft.groupName" placeholder="建群时默认带入，可再修改" maxlength="64" show-word-limit />
        </el-form-item>
        <el-form-item label="群成员（工号）">
          <el-input
            v-model="draft.membersInput"
            type="textarea"
            :rows="5"
            placeholder="用逗号 / 分号 / 空格 / 换行分隔，如：E-0001, E-0002"
          />
          <div class="tpl__members-meta">已识别 {{ members.length }} 名成员</div>
        </el-form-item>
        <el-form-item label="说明（可选）">
          <el-input v-model="draft.description" type="textarea" :rows="2" placeholder="模板用途备注" maxlength="200" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="submitting" @click="submit">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.tpl {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.tpl__toolbar {
  display: flex;
  align-items: center;
  gap: 10px;
}

.tpl__hint {
  font-size: 12.5px;
  color: var(--ht-text-3);
}

.tpl__spacer {
  flex: 1;
}

.tpl__name {
  font-weight: 600;
  color: var(--ht-text-1);
}

.tpl__members-meta {
  margin-top: 6px;
  font-size: 12px;
  color: var(--ht-text-3);
}
</style>
