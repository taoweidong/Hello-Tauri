<script setup lang="ts">
/**
 * Tab「快速建群」（migration v3）—— 选模板 → 定制信息 → 确认外呼。
 *
 * 三条交互约定：
 *  * **确认弹层是外呼的前置**：建群拉真人进群，是对外动作；无论 mock 还是真实
 *    CLI，提交前都必须弹确认（真实 CLI 时弹层会标注「真实建群」）；
 *  * **模板只做预填**：选中模板把群名称与成员填进表单，用户可任意改 ——
 *    「选择后定制信息」是需求原文，模板不是一次性信封；
 *  * **失败保留表单**：外呼失败不清空输入，错误就地展示，改完可直接重试。
 */
import { computed, reactive, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import type { FormInstance, FormRules } from 'element-plus'

import { IconUsers } from '@/components/icons'
import { useGroupStore } from '@/stores/group'
import { useAppStore } from '@/stores/app'
import { platform } from '@/api'
import { normalizeWelinkSettings, normalizeMemberIds } from '@/types/welink'
import type { GroupTemplate } from '@/types/welink'
import { validateGroupDraft } from '@/orchestrator/group'

const emit = defineEmits<{ (e: 'switch-tab', tab: 'templates' | 'history'): void }>()

const store = useGroupStore()
const appStore = useAppStore()

const formRef = ref<FormInstance>()
/**
 * 表单模型必须是**单一 reactive 对象**喂给 el-form 的 `:model`：
 * Element Plus 的 validate/clearValidate 按 `prop` 路径从 model 里取值，
 * 只给 rules 不给 model 会让校验静默失败（行内错误都不渲染）。
 */
const draft = reactive<{ templatePk: number | null; groupName: string; membersInput: string }>({
  templatePk: null,
  groupName: '',
  membersInput: '',
})

/** 归一化后的成员清单（实时回显，与提交口径一致） */
const members = computed(() => normalizeMemberIds(draft.membersInput))
const selectedTemplate = computed(() => store.templates.find((item) => item.pk === draft.templatePk) ?? null)

/** 数据源徽标：真实 CLI 建群 vs 模拟建群（与 WeLink 页同款提示思路） */
const realCli = computed(() => {
  if (platform !== 'tauri') return false
  return normalizeWelinkSettings(appStore.settings.weLink).welinkSource === 'cli'
})

const rules: FormRules = {
  groupName: [
    { required: true, message: '请输入群名称', trigger: 'blur' },
    { max: 64, message: '群名称不能超过 64 字', trigger: 'blur' },
  ],
}

/** 选中模板 → 预填表单（模板只做预填，不是一次性信封） */
watch(
  () => draft.templatePk,
  (pk) => {
    const template: GroupTemplate | undefined = store.templates.find((item) => item.pk === pk)
    if (!template) return
    draft.groupName = template.groupName
    draft.membersInput = template.members.join(', ')
  },
)

async function submit() {
  const form = formRef.value
  if (!form) return
  const valid = await form.validate().catch(() => false)
  if (!valid) return

  const jobDraft = {
    templatePk: selectedTemplate.value?.pk ?? null,
    templateName: selectedTemplate.value?.name ?? '',
    groupName: draft.groupName.trim(),
    members: members.value,
  }
  const problems = validateGroupDraft(jobDraft)
  if (problems.length) {
    ElMessage.warning(problems.join('；'))
    return
  }

  const source = realCli.value ? '将调用 welink-cli 真实建群' : '当前为模拟数据源，不会真正建群'
  const confirmed = await ElMessageBox.confirm(
    `将创建群「${jobDraft.groupName}」并邀请 ${jobDraft.members.length} 名成员。${source}，确认创建？`,
    '确认建群',
    { type: 'warning', confirmButtonText: '创建', cancelButtonText: '取消' },
  ).catch(() => false)
  if (confirmed === false) return

  try {
    const job = await store.createGroup(jobDraft)
    if (job.status === 'success') {
      ElMessage.success(`建群成功（群 ID：${job.groupId || '未回传'}）`)
    } else {
      ElMessage.error(`建群失败：${job.error}`)
    }
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '建群失败')
  }
}

function clearForm() {
  draft.templatePk = null
  draft.groupName = ''
  draft.membersInput = ''
  formRef.value?.clearValidate()
}
</script>

<template>
  <div class="create">
    <el-alert
      v-if="store.templatesLoaded && !store.templates.length"
      type="info"
      :closable="false"
      show-icon
      title="还没有建群模板"
      description="可不选模板直接填写下方信息；常用群建议先建模板，之后一键带入。"
    >
      <template #default>
        <div class="create__empty-actions">
          <span>可不选模板直接填写下方信息；常用群建议先建模板，之后一键带入。</span>
          <el-button size="small" type="primary" plain @click="emit('switch-tab', 'templates')">去建模板</el-button>
        </div>
      </template>
    </el-alert>

    <el-form ref="formRef" class="create__form" :model="draft" label-position="top" :rules="rules" @submit.prevent>
      <el-form-item label="建群模板（可选）">
        <el-select
          v-model="draft.templatePk"
          placeholder="不使用模板，直接填写"
          clearable
          class="create__select"
          :disabled="store.creating"
        >
          <el-option v-for="item in store.templates" :key="item.pk" :value="item.pk" :label="item.name">
            <span class="create__option">
              <span>{{ item.name }}</span>
              <span class="create__option-meta">{{ item.members.length }} 人</span>
            </span>
          </el-option>
        </el-select>
        <div v-if="selectedTemplate?.description" class="create__template-desc">{{ selectedTemplate.description }}</div>
      </el-form-item>

      <el-form-item label="群名称" prop="groupName">
        <el-input
          v-model="draft.groupName"
          placeholder="输入群名称，如：项目周会群"
          maxlength="64"
          show-word-limit
          :disabled="store.creating"
        />
      </el-form-item>

      <el-form-item label="群成员（工号）">
        <el-input
          v-model="draft.membersInput"
          type="textarea"
          :rows="4"
          placeholder="输入成员工号，用逗号 / 分号 / 空格 / 换行分隔，如：E-0001, E-0002"
          :disabled="store.creating"
        />
        <div class="create__members-meta">
          <span :class="{ 'is-empty': !members.length }">已识别 {{ members.length }} 名成员</span>
          <span v-if="members.length" class="create__members-preview"
            >{{ members.slice(0, 8).join('、') }}{{ members.length > 8 ? ' 等' : '' }}</span
          >
        </div>
      </el-form-item>

      <div class="create__actions">
        <el-button type="primary" :loading="store.creating" :icon="IconUsers" @click="submit">
          {{ store.creating ? '创建中…' : '创建群聊' }}
        </el-button>
        <el-button :disabled="store.creating" @click="clearForm">清空</el-button>
        <span class="create__source">
          {{ realCli ? '真实建群（welink-cli）' : '模拟数据源：不会真正建群' }}
        </span>
      </div>
    </el-form>
  </div>
</template>

<style scoped>
.create {
  display: flex;
  flex-direction: column;
  gap: 14px;
  max-width: 640px;
}

.create__empty-actions {
  display: flex;
  align-items: center;
  gap: 10px;
}

.create__form {
  margin-top: 2px;
}

.create__select {
  width: 100%;
}

.create__option {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.create__option-meta {
  font-size: 12px;
  color: var(--ht-text-3);
}

.create__template-desc {
  margin-top: 6px;
  font-size: 12px;
  color: var(--ht-text-3);
  line-height: 1.5;
}

.create__members-meta {
  display: flex;
  align-items: baseline;
  gap: 10px;
  margin-top: 6px;
  font-size: 12px;
  color: var(--ht-text-2);
}

.create__members-meta .is-empty {
  color: var(--ht-text-3);
  opacity: 0.75;
}

.create__members-preview {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--ht-text-3);
}

.create__actions {
  display: flex;
  align-items: center;
  gap: 10px;
}

.create__source {
  margin-left: auto;
  font-size: 12px;
  color: var(--ht-text-3);
}
</style>
