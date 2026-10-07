<script setup lang="ts">
/**
 * Settings 页「知识库」卡 —— 本地 Markdown 知识源的管理面（capability:
 * knowledge-base + knowledge-sedimentation 评审队列入口）。
 *
 * 语义约定（spec：knowledge-base / knowledge-sedimentation）：
 *  * 下架 = 从清单移除、文件保留（fs 通道无删文件能力，物理删除列非目标）；
 *  * 登记 = 手动放入 knowledge/ 的文件录入清单（应用无列目录能力，登记即对账）；
 *  * 清单条目带来源（manual 手动 | extract 沉淀提取 | qa 问答归档），沉淀产物与
 *    手动文档同权管理；
 *  * 待评审队列：沉淀提取条目经「通过（新建/并入）或拒绝」后进出知识库——
 *    评审即可信化闸门（K-E）；
 *  * web 调试模式文件通道不可用 → 整卡降级提示。
 *
 * 数据访问一律经 knowledgeStore（UI 禁触 @/infra/**，D4 闸门）。
 */
import { computed, onMounted, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'

import { IconPlus, IconRefresh } from '@/components/icons'
import { useKnowledgeStore } from '@/stores/welink/knowledge'
import { toKnowledgeFileName, type KnowledgeDocSource } from '@/types/knowledge'

const knowledgeStore = useKnowledgeStore()
const available = knowledgeStore.fsAvailable

const SOURCE_LABEL: Record<KnowledgeDocSource, string> = {
  manual: '手动',
  extract: '沉淀',
  qa: '问答',
}

const loading = ref(false)
const editing = ref<null | { file: string; title: string; content: string; isNew: boolean }>(null)
const registering = ref<null | { file: string; title: string }>(null)

/** 评审对话框：通过时可编辑标题正文，并选新建文档或并入既有文档 */
const reviewing = ref<null | {
  pk: number
  title: string
  content: string
  mode: 'new' | 'append'
  targetFile: string
  sourceType: string
  sourceRefs: string[]
}>(null)

const docs = computed(() => knowledgeStore.docs)

async function load() {
  loading.value = true
  try {
    await knowledgeStore.loadDocs()
  } catch (error) {
    ElMessage.error(`知识库清单读取失败：${error instanceof Error ? error.message : String(error)}`)
  } finally {
    loading.value = false
  }
}

async function loadQueue() {
  try {
    await knowledgeStore.loadDrafts()
  } catch {
    // 评审队列加载失败不阻断知识库管理（桌面模式下重试即可）
  }
}

function openNew() {
  editing.value = { file: '', title: '', content: '', isNew: true }
}

async function openEdit(doc: { file: string; title: string }) {
  const content = await knowledgeStore.readDoc(doc.file)
  if (content === null) {
    ElMessage.warning(`文件已被移走（${doc.file}）：可重新登记同名文件，或直接下架该条目`)
    return
  }
  editing.value = { file: doc.file, title: doc.title, content, isNew: false }
}

async function saveEdit() {
  const draft = editing.value
  if (!draft) return
  if (!draft.title.trim()) {
    ElMessage.warning('标题必填')
    return
  }
  const file = draft.isNew ? toKnowledgeFileName(draft.file, draft.title) : draft.file
  if (!file) {
    ElMessage.warning('文件名不能为空（可用中文、字母、数字与连字符）')
    return
  }
  if (draft.isNew && knowledgeStore.docs.some((item) => item.file === file)) {
    ElMessage.warning(`同名文件已在清单中：${file}`)
    return
  }
  try {
    await knowledgeStore.saveDoc({ file, title: draft.title.trim() || file, content: draft.content, source: 'manual', overwrite: !draft.isNew })
    ElMessage.success('知识文档已保存')
    editing.value = null
  } catch (error) {
    ElMessage.error(`保存失败：${error instanceof Error ? error.message : String(error)}`)
  }
}

async function offShelf(doc: { file: string; title: string }) {
  try {
    await ElMessageBox.confirm(
      `下架「${doc.title}」？文件本身保留在数据根 knowledge/ 目录，仅停止在列表与检索供给中使用。`,
      '下架确认',
      { type: 'warning', confirmButtonText: '下架', cancelButtonText: '取消' },
    )
  } catch {
    return
  }
  await knowledgeStore.offShelf(doc.file)
  ElMessage.success('已下架（文件已保留在 knowledge/ 目录）')
}

function openRegister() {
  registering.value = { file: '', title: '' }
}

async function saveRegister() {
  const draft = registering.value
  if (!draft) return
  const file = toKnowledgeFileName(draft.file, draft.title)
  if (!file) {
    ElMessage.warning('文件名不能为空（含 .md 后缀）')
    return
  }
  try {
    await knowledgeStore.registerDoc({ file, title: draft.title.trim() || file })
    ElMessage.success('已登记')
    registering.value = null
  } catch (error) {
    if (error instanceof Error && error.message.includes('未找到')) {
      ElMessage.warning(error.message)
      return
    }
    ElMessage.error(`登记失败：${error instanceof Error ? error.message : String(error)}`)
  }
}

// —— 待评审队列（K-E 评审闸） ——

function openReview(draft: { pk: number; title: string; content: string; sourceType: string; sourceRefs: string[] }) {
  reviewing.value = {
    pk: draft.pk,
    title: draft.title,
    content: draft.content,
    mode: 'new',
    targetFile: '',
    sourceType: draft.sourceType,
    sourceRefs: draft.sourceRefs,
  }
}

async function approveDraft() {
  const draft = reviewing.value
  if (!draft) return
  if (!draft.title.trim() || !draft.content.trim()) {
    ElMessage.warning('标题与正文都不能为空')
    return
  }
  if (draft.mode === 'append' && !draft.targetFile) {
    ElMessage.warning('请选择要并入的文档')
    return
  }
  try {
    const ok = await knowledgeStore.approveDraft(
      draft.pk,
      { title: draft.title.trim(), content: draft.content.trim() },
      draft.mode === 'append' ? { file: draft.targetFile } : undefined,
    )
    if (!ok) {
      ElMessage.warning('该条目已被评审过')
      await loadQueue()
      reviewing.value = null
      return
    }
    ElMessage.success(draft.mode === 'append' ? '已并入既有文档' : '已写入知识库')
    reviewing.value = null
  } catch (error) {
    ElMessage.error(`写入知识库失败：${error instanceof Error ? error.message : String(error)}`)
  }
}

async function rejectDraft(draft: { pk: number; title: string }) {
  try {
    await ElMessageBox.confirm(`拒绝「${draft.title}」？该条目将退出待评审队列，知识库不变。`, '拒绝确认', {
      type: 'warning',
      confirmButtonText: '拒绝',
      cancelButtonText: '取消',
    })
  } catch {
    return
  }
  const ok = await knowledgeStore.rejectDraft(draft.pk, '人工拒绝')
  if (ok) ElMessage.success('已拒绝')
  else ElMessage.warning('该条目已被评审过')
  await loadQueue()
}

const SOURCE_TYPE_LABEL: Record<string, string> = {
  message: '群消息',
  announcement: '群公告',
  qa: '问答',
}

defineExpose({ load, openNew, openEdit, saveEdit, offShelf, openRegister, saveRegister, openReview, approveDraft, rejectDraft, registering, editing })
const listEmpty = computed(() => !loading.value && knowledgeStore.docsLoaded && docs.value.length === 0)
const queueEmpty = computed(() => knowledgeStore.draftCount === 0)
onMounted(() => {
  if (available) {
    void load()
    void loadQueue()
  }
})

</script>

<template>
  <section class="ht-card kb">
    <header class="ht-card__head">
      <span>知识库（Markdown）</span>
      <span class="spacer" />
      <el-tag size="small" effect="plain" round>{{ docs.length }} 篇</el-tag>
    </header>

    <div class="kb__body">
      <template v-if="available">
        <!-- 待评审队列（沉淀提取条目；评审即可信化闸门） -->
        <div v-if="!queueEmpty" class="kb__queue">
          <div class="kb__queue-title">待评审知识（{{ knowledgeStore.draftCount }}）</div>
          <ul class="kb__list">
            <li v-for="draft in knowledgeStore.drafts" :key="draft.pk" class="kb__row kb__row--draft">
              <span class="kb__title">{{ draft.title }}</span>
              <el-tag size="small" effect="plain" type="warning">{{ SOURCE_TYPE_LABEL[draft.sourceType] || draft.sourceType }}</el-tag>
              <span class="kb__draft-content">{{ draft.content }}</span>
              <span class="spacer" />
              <el-button link type="primary" size="small" @click="openReview(draft)">评审</el-button>
              <el-button link type="danger" size="small" @click="rejectDraft(draft)">拒绝</el-button>
            </li>
          </ul>
        </div>

        <div class="kb__toolbar">
          <span class="kb__hint">知识源文件在数据根 knowledge/ 目录；更新文档后请在 RAG 服务侧同步索引。</span>
          <span class="spacer" />
          <el-button size="small" :icon="IconRefresh" :loading="loading" @click="load">刷新</el-button>
          <el-button size="small" @click="openRegister">登记已有文件</el-button>
          <el-button size="small" type="primary" :icon="IconPlus" @click="openNew">新建文档</el-button>
        </div>

        <p v-if="listEmpty" class="kb__empty">知识库为空：新建 Markdown 文档，或把已有 md 文件放入数据根 knowledge/ 目录后「登记」。</p>

        <ul class="kb__list">
          <li v-for="doc in docs" :key="doc.file" class="kb__row">
            <span class="kb__title">{{ doc.title }}</span>
            <el-tag size="small" effect="plain" :type="doc.source === 'manual' ? 'info' : 'success'">{{ SOURCE_LABEL[doc.source] }}</el-tag>
            <span class="kb__file mono">{{ doc.file }}</span>
            <span class="spacer" />
            <span class="kb__time">{{ doc.updatedAt }}</span>
            <el-button link type="primary" size="small" @click="openEdit(doc)">编辑</el-button>
            <el-button link type="danger" size="small" @click="offShelf(doc)">下架</el-button>
          </li>
        </ul>

        <!-- 新建 / 编辑（同一时刻至多一个） -->
        <div v-if="editing" class="kb__edit">
          <div class="kb__edit-title">{{ editing.isNew ? '新建知识文档' : `编辑：${editing.title}` }}</div>
          <el-form label-width="92px" @submit.prevent>
            <el-form-item label="标题">
              <el-input v-model="editing.title" class="kb__control" placeholder="如：VPN 常见问题" />
            </el-form-item>
            <el-form-item v-if="editing.isNew" label="文件名">
              <el-input v-model="editing.file" class="kb__control" placeholder="留空则按标题生成（.md）" />
            </el-form-item>
          </el-form>
          <el-input v-model="editing.content" type="textarea" :rows="14" class="kb__textarea" placeholder="Markdown 正文……" />
          <div class="kb__edit-bar">
            <el-button size="small" @click="editing = null">取消</el-button>
            <el-button size="small" type="primary" @click="saveEdit">保存</el-button>
          </div>
        </div>

        <!-- 登记手动文件 -->
        <div v-if="registering" class="kb__edit">
          <div class="kb__edit-title">登记已有文件（knowledge/ 目录下）</div>
          <el-form label-width="92px" @submit.prevent>
            <el-form-item label="文件名">
              <el-input v-model="registering.file" class="kb__control" placeholder="如 vpn-faq.md" />
            </el-form-item>
            <el-form-item label="标题">
              <el-input v-model="registering.title" class="kb__control" placeholder="如 VPN 常见问题" />
            </el-form-item>
          </el-form>
          <div class="kb__edit-bar">
            <el-button size="small" @click="registering = null">取消</el-button>
            <el-button size="small" type="primary" @click="saveRegister">登记</el-button>
          </div>
        </div>

        <!-- 评审（通过 = 写知识库；可选新建或并入） -->
        <div v-if="reviewing" class="kb__edit">
          <div class="kb__edit-title">评审知识条目</div>
          <div class="kb__hint">
            来源：{{ SOURCE_TYPE_LABEL[reviewing.sourceType] || reviewing.sourceType }}
            <template v-if="reviewing.sourceRefs.length">（引用：{{ reviewing.sourceRefs.join('、') }}）</template>
          </div>
          <el-form label-width="92px" @submit.prevent>
            <el-form-item label="写入方式">
              <el-radio-group v-model="reviewing.mode">
                <el-radio-button value="new">新建文档</el-radio-button>
                <el-radio-button value="append">并入既有</el-radio-button>
              </el-radio-group>
            </el-form-item>
            <el-form-item v-if="reviewing.mode === 'append'" label="目标文档">
              <el-select v-model="reviewing.targetFile" filterable placeholder="选择要并入的文档" class="kb__control">
                <el-option v-for="doc in docs" :key="doc.file" :value="doc.file" :label="doc.title" />
              </el-select>
            </el-form-item>
            <el-form-item label="标题">
              <el-input v-model="reviewing.title" class="kb__control" />
            </el-form-item>
          </el-form>
          <el-input v-model="reviewing.content" type="textarea" :rows="8" class="kb__textarea" />
          <div class="kb__edit-bar">
            <el-button size="small" @click="reviewing = null">取消</el-button>
            <el-button size="small" type="primary" @click="approveDraft">通过并写入</el-button>
          </div>
        </div>
      </template>

      <el-alert v-else type="info" :closable="false" show-icon title="知识库管理需桌面模式" description="浏览器调试模式下无法读写本地文件；检索链路可用「模拟检索」照常演示。" />
    </div>
  </section>
</template>

<style scoped>
.kb {
  display: flex;
  flex-direction: column;
}

.ht-card__head .spacer,
.spacer {
  flex: 1;
}

.kb__body {
  padding: 6px 16px 14px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.kb__toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
}

.kb__hint {
  font-size: 11.5px;
  color: var(--ht-text-3);
  line-height: 1.7;
}

.kb__empty {
  margin: 0;
  font-size: 12px;
  color: var(--ht-text-3);
}

.kb__list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.kb__row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  border: 1px solid var(--ht-border, #dcdfe6);
  border-radius: 6px;
}

.kb__row--draft {
  border-style: dashed;
}

.kb__queue {
  border: 1px dashed var(--ht-border, #dcdfe6);
  border-radius: 6px;
  padding: 8px 10px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.kb__queue-title {
  font-size: 12.5px;
  font-weight: 600;
}

.kb__draft-content {
  font-size: 11px;
  color: var(--ht-text-3);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 320px;
}

.kb__title {
  font-size: 12.5px;
  font-weight: 600;
}

.kb__file {
  font-size: 11px;
  color: var(--ht-text-3);
}

.mono {
  font-family: var(--ht-font-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace);
}

.kb__time {
  font-size: 11px;
  color: var(--ht-text-3);
}

.kb__edit {
  border: 1px solid var(--ht-border, #dcdfe6);
  border-radius: 6px;
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.kb__edit-title {
  font-size: 12.5px;
  font-weight: 600;
}

.kb__edit-bar {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

.kb__control {
  width: 260px;
}

.kb__textarea :deep(textarea) {
  font-family: var(--ht-font-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace);
  font-size: 12px;
  line-height: 1.65;
}
</style>
