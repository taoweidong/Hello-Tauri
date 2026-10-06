<script setup lang="ts">
/**
 * 大模型卡·回复技能分区（skill-routing 设计 §10）。
 *
 * 技能 = 一类问题的「匹配规则 + 专属模板 + 静态知识块 + 审核模式」。规则命中
 * 顺序即技能数组顺序（先配置先匹配），上移/下移表达优先级。兜底技能（通用助手）
 * 不在本区管理 —— 它的模板就是「兜底技能（通用助手）」分区（原提示词模板）。
 *
 * 编辑器独立渲染在列表下方，同一时刻至多一个（editingId/editingDraft）。
 * 列表操作（增删改/启停/排序）整字段替换 `agent.skills` 数组，父级 deep watch
 * 照常触发热更新；操作函数显式暴露（defineExpose）供契约测试驱动，避免对
 * 桩掉的 EP 组件做脆交互。id 不在 UI 侧手工生成：保存时留空交给
 * normalizeWelinkSettings 统一 slug 化去重。
 */
import { computed, ref } from 'vue'
import { ElMessage } from 'element-plus'

import { IconPlus, IconTrash } from '@/components/icons'
import {
  MAX_WELINK_SKILLS,
  PROMPT_PLACEHOLDERS,
  type WelinkSettings,
  type WelinkSkill,
} from '@/types/welink'

const agent = defineModel<WelinkSettings['agent']>({ required: true })

/** 新建态的编辑器标识（真实技能 id 不会是它 —— 归一化会给空 id 派生 skill-N） */
const NEW_ID = '__new__'

const editingId = ref<string | null>(null)
const editingDraft = ref<WelinkSkill | null>(null)

const skills = computed(() => agent.value.skills)
const atLimit = computed(() => skills.value.length >= MAX_WELINK_SKILLS)

/** 编辑器里的关键词输入（逗号/顿号分隔的展示形式 ⇄ 数组） */
const keywordsText = computed({
  get: () => (editingDraft.value?.keywords ?? []).join(', '),
  set: (value: string) => {
    if (!editingDraft.value) return
    editingDraft.value = {
      ...editingDraft.value,
      keywords: value
        .split(/[,，、]+/)
        .map((item) => item.trim())
        .filter(Boolean),
    }
  },
})

const editingMissingPlaceholders = computed(() =>
  editingDraft.value ? ['{{context}}', '{{question}}'].filter((token) => !editingDraft.value!.promptTemplate.includes(token)) : [],
)

function startAdd() {
  if (atLimit.value) {
    ElMessage.warning(`技能最多 ${MAX_WELINK_SKILLS} 个`)
    return
  }
  editingId.value = NEW_ID
  editingDraft.value = {
    id: '',
    name: '',
    description: '',
    enabled: true,
    keywords: [],
    promptTemplate: '',
    knowledge: '',
    reviewMode: 'auto',
    retrieval: { enabled: false },
  }
}

function startEdit(skill: WelinkSkill) {
  editingId.value = skill.id
  editingDraft.value = { ...skill, keywords: [...skill.keywords] }
}

function closeEditor() {
  editingId.value = null
  editingDraft.value = null
}

function saveEditor() {
  const draft = editingDraft.value
  if (!draft) return
  if (!draft.name.trim()) {
    ElMessage.warning('技能名称必填')
    return
  }
  const list = [...agent.value.skills]
  const at = editingId.value === NEW_ID ? -1 : list.findIndex((item) => item.id === editingId.value)
  if (at >= 0) list[at] = { ...draft }
  else list.push({ ...draft })
  agent.value = { ...agent.value, skills: list }
  ElMessage.success('技能已保存（id 由保存归一化分配/去重）')
  closeEditor()
}

function removeSkill(id: string) {
  agent.value = { ...agent.value, skills: agent.value.skills.filter((item) => item.id !== id) }
  if (editingId.value === id) closeEditor()
}

function setEnabled(id: string, enabled: boolean) {
  agent.value = {
    ...agent.value,
    skills: agent.value.skills.map((item) => (item.id === id ? { ...item, enabled } : item)),
  }
}

/** 上移/下移：数组顺序 = 规则匹配优先级（设计 §7「先配置先匹配」） */
function move(id: string, delta: -1 | 1) {
  const list = [...agent.value.skills]
  const at = list.findIndex((item) => item.id === id)
  const to = at + delta
  if (at < 0 || to < 0 || to >= list.length) return
  ;[list[at], list[to]] = [list[to], list[at]]
  agent.value = { ...agent.value, skills: list }
}

function insertPlaceholder(token: string) {
  if (!editingDraft.value) return
  editingDraft.value = { ...editingDraft.value, promptTemplate: `${editingDraft.value.promptTemplate}\n${token}` }
}

// editingDraft 一并暴露：编辑器表单是行内状态（无 props 入口），契约测试经由它
// 驱动「填草稿 → 保存」，避免对桩掉的 EP 表单组件做脆交互
defineExpose({ startAdd, startEdit, saveEditor, closeEditor, removeSkill, setEnabled, move, editingDraft })
</script>

<template>
  <el-collapse-item name="skills" title="回复技能">
    <div class="sk">
      <div class="sk__bar">
        <el-switch v-model="agent.llmClassifyFallback" size="small" />
        <span class="sk__bar-label">规则未命中时让大模型分类兜底</span>
        <span class="wc__hint">开启后未命中关键词的问题多一次分类调用；清单里只有兜底技能时自动跳过</span>
      </div>

      <div class="sk__toolbar">
        <span class="wc__hint">
          按顺序匹配，先配置先命中（上移/下移调优先级）；停用的技能不参与路由。最多 {{ MAX_WELINK_SKILLS }} 个。
        </span>
        <span class="spacer" />
        <el-button size="small" type="primary" :icon="IconPlus" :disabled="atLimit" @click="startAdd">添加技能</el-button>
      </div>

      <p v-if="!skills.length" class="sk__empty">未配置技能：全部消息走「兜底技能（通用助手）」模板回复。</p>

      <ul class="sk__list">
        <li v-for="(skill, index) in skills" :key="skill.id" class="sk__row">
          <span class="sk__name" :class="{ 'sk__name--off': !skill.enabled }">{{ skill.name }}</span>
          <el-tag v-if="skill.reviewMode === 'manual'" size="small" type="warning" effect="plain">需人工审核</el-tag>
          <el-tag size="small" effect="plain" class="sk__meta">{{ skill.keywords.length }} 个关键词</el-tag>
          <span class="spacer" />
          <el-button link size="small" :disabled="index === 0" @click="move(skill.id, -1)">上移</el-button>
          <el-button link size="small" :disabled="index === skills.length - 1" @click="move(skill.id, 1)">下移</el-button>
          <el-switch
            :model-value="skill.enabled"
            size="small"
            inline-prompt
            active-text="启用"
            inactive-text="停用"
            @update:model-value="(value: string | number | boolean) => setEnabled(skill.id, Boolean(value))"
          />
          <el-button link type="primary" size="small" @click="startEdit(skill)">编辑</el-button>
          <el-button link type="danger" size="small" :icon="IconTrash" @click="removeSkill(skill.id)">删除</el-button>
        </li>
      </ul>

      <!--
        编辑器独立渲染在列表下方（新建与编辑共用一处）。
        评审修复记录：最初把编辑器放在 v-for 行内、靠 `editingId === skill.id` 匹配渲染，
        新建态（__new__ 不在清单里）编辑器永远不出现——GUI 走查发现，组件渲染探针钉住。
      -->
      <div v-if="editingDraft" class="sk__edit">
        <div class="sk__edit-title">{{ editingId === NEW_ID ? '新建技能' : `编辑：${editingDraft.name || ''}` }}</div>
        <el-form label-width="92px" @submit.prevent>
          <el-form-item label="名称">
            <el-input v-model="editingDraft.name" class="wc__control" placeholder="如：故障咨询" />
          </el-form-item>
          <el-form-item label="说明">
            <el-input
              v-model="editingDraft.description"
              type="textarea"
              :rows="2"
              placeholder="什么问题该选这个技能 —— 这是大模型分类时的唯一选择依据"
            />
          </el-form-item>
          <el-form-item label="关键词">
            <el-input v-model="keywordsText" class="wc__control" placeholder="逗号分隔，如：报错, /接口.*异常/" />
            <span class="wc__hint">普通词包含匹配；/…/ 形式按正则解释（不区分大小写）</span>
          </el-form-item>
          <el-form-item label="模板">
            <div class="sk__tokens">
              <el-tag
                v-for="token in PROMPT_PLACEHOLDERS"
                :key="token"
                size="small"
                effect="plain"
                class="wc__token pressable"
                @click="insertPlaceholder(token)"
              >{{ token }}</el-tag>
            </div>
            <el-input v-model="editingDraft.promptTemplate" type="textarea" :rows="6" class="wc__textarea" />
            <el-alert
              v-if="editingMissingPlaceholders.length"
              class="wc__alert"
              type="warning"
              :closable="false"
              show-icon
              :title="`模板缺少占位符：${editingMissingPlaceholders.join('、')}`"
            />
            <span class="wc__hint">留空 = 回退兜底技能模板</span>
          </el-form-item>
          <el-form-item label="知识块">
            <el-input
              v-model="editingDraft.knowledge"
              type="textarea"
              :rows="4"
              placeholder="该类问题的固定口径 / FAQ，注入模板 {{knowledge}} 占位符"
            />
          </el-form-item>
          <el-form-item label="知识检索">
            <el-switch v-model="editingDraft.retrieval.enabled" size="small" />
            <span class="wc__hint">生成前按此技能检索知识库（RAG），命中片段经模板的 retrieved 占位符注入</span>
            <el-input
              v-if="editingDraft.retrieval.enabled"
              v-model="editingDraft.retrieval.filter"
              class="kb__control"
              placeholder="过滤条件（可选，如分类标签），原样透传给检索服务"
            />
          </el-form-item>
          <el-form-item label="人工审核">
            <el-switch v-model="editingDraft.reviewMode" active-value="manual" inactive-value="auto" />
            <span class="wc__hint">开启后该技能生成的草稿一律转人工待审，不自动外发</span>
          </el-form-item>
        </el-form>
        <div class="sk__edit-bar">
          <el-button size="small" @click="closeEditor">取消</el-button>
          <el-button size="small" type="primary" @click="saveEditor">保存</el-button>
        </div>
      </div>
    </div>
  </el-collapse-item>
</template>

<style scoped>
.sk {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.sk__bar {
  display: flex;
  align-items: center;
  gap: 8px;
}

.sk__bar-label {
  font-size: 12.5px;
}

.sk__toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
}

.sk__toolbar .spacer,
.spacer {
  flex: 1;
}

.sk__empty {
  margin: 0;
  font-size: 12px;
  color: var(--ht-text-3);
}

.sk__list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.sk__row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  border: 1px solid var(--ht-border, #dcdfe6);
  border-radius: 6px;
}

.sk__name {
  font-size: 12.5px;
  font-weight: 600;
}

.sk__name--off {
  color: var(--ht-text-3);
  text-decoration: line-through;
}

.sk__meta {
  color: var(--ht-text-3);
}

.sk__edit {
  width: 100%;
}

.sk__edit-bar {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

.sk__tokens {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  margin-bottom: 6px;
}

.wc__hint {
  margin-left: 10px;
  font-size: 11.5px;
  color: var(--ht-text-3);
  line-height: 1.7;
}

.wc__control {
  width: 260px;
}

.wc__textarea :deep(textarea) {
  font-family: var(--ht-font-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace);
  font-size: 12px;
  line-height: 1.65;
}

.wc__alert {
  margin: 8px 0;
}

.wc__token {
  cursor: copy;
}
</style>
