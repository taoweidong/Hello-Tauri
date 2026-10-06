<script setup lang="ts">
/**
 * Settings 页「知识库」卡 —— 本地 Markdown 知识源的管理面（capability:
 * knowledge-base）。知识源 = 数据根 `knowledge/*.md`，清单真源 = `knowledge/
 * index.json`，读写走既有 fsRead/fsWrite（数据根内安全通道，写自动建父目录，
 * 零 Rust）。
 *
 * 语义约定（spec：knowledge-base）：
 *  * 下架 = 从清单移除、文件保留（fs 通道无删文件能力，物理删除列非目标）；
 *  * 登记 = 手动放入 knowledge/ 的文件录入清单（应用无列目录能力，登记即对账）；
 *  * web 调试模式文件通道不可用 → 整卡降级提示（检索增强经 mock 照常可演示）。
 */
import { computed, onMounted, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'

import { bridge, platform } from '@/api'
import { IconPlus, IconRefresh } from '@/components/icons'
import { nowStamp } from '@/utils/time'

interface KnowledgeDoc {
  file: string
  title: string
  updatedAt: string
}

const INDEX_FILE = 'knowledge/index.json'
const available = platform === 'tauri'

const docs = ref<KnowledgeDoc[]>([])
const loading = ref(false)
const editing = ref<null | { file: string; title: string; content: string; isNew: boolean }>(null)
const registering = ref<null | { file: string; title: string }>(null)

/** 文件名收敛：小写/数字/中文/连字符；空 → 由标题派生；保证 .md 后缀 */
function toFileName(input: string, title: string): string {
  const base = (input || title)
    .trim()
    .toLowerCase()
    .replace(/[\s\\/:*?"<>|]+/g, '-')
    .replace(/^-+|-+$/g, '')
  const name = base.endsWith('.md') ? base : `${base}.md`
  return name === '.md' ? '' : name
}

async function load() {
  loading.value = true
  try {
    const raw = await bridge.fsRead(INDEX_FILE)
    docs.value = raw ? ((JSON.parse(raw).docs ?? []) as KnowledgeDoc[]) : []
  } catch (error) {
    ElMessage.error(`知识库清单读取失败：${error instanceof Error ? error.message : String(error)}`)
  } finally {
    loading.value = false
  }
}

async function persistIndex() {
  await bridge.fsWrite(INDEX_FILE, JSON.stringify({ docs: docs.value }, null, 2))
}

function openNew() {
  editing.value = { file: '', title: '', content: '', isNew: true }
}

async function openEdit(doc: KnowledgeDoc) {
  const content = await bridge.fsRead(`knowledge/${doc.file}`)
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
  const file = draft.isNew ? toFileName(draft.file, draft.title) : draft.file
  if (!file) {
    ElMessage.warning('文件名不能为空（可用中文、字母、数字与连字符）')
    return
  }
  if (draft.isNew && docs.value.some((item) => item.file === file)) {
    ElMessage.warning(`同名文件已在清单中：${file}`)
    return
  }
  try {
    await bridge.fsWrite(`knowledge/${file}`, draft.content)
    const entry: KnowledgeDoc = { file, title: draft.title.trim() || file, updatedAt: nowStamp() }
    docs.value = draft.isNew ? [...docs.value, entry] : docs.value.map((item) => (item.file === file ? entry : item))
    await persistIndex()
    ElMessage.success('知识文档已保存')
    editing.value = null
  } catch (error) {
    ElMessage.error(`保存失败：${error instanceof Error ? error.message : String(error)}`)
  }
}

async function offShelf(doc: KnowledgeDoc) {
  try {
    await ElMessageBox.confirm(
      `下架「${doc.title}」？文件本身保留在数据根 knowledge/ 目录，仅停止在列表与检索供给中使用。`,
      '下架确认',
      { type: 'warning', confirmButtonText: '下架', cancelButtonText: '取消' },
    )
  } catch {
    return
  }
  docs.value = docs.value.filter((item) => item.file !== doc.file)
  await persistIndex()
  ElMessage.success('已下架（文件已保留在 knowledge/ 目录）')
}

function openRegister() {
  registering.value = { file: '', title: '' }
}

async function saveRegister() {
  const draft = registering.value
  if (!draft) return
  const file = toFileName(draft.file, draft.title)
  if (!file) {
    ElMessage.warning('文件名不能为空（含 .md 后缀）')
    return
  }
  if (docs.value.some((item) => item.file === file)) {
    ElMessage.warning('该文件已在清单中')
    return
  }
  const content = await bridge.fsRead(`knowledge/${file}`)
  if (content === null) {
    ElMessage.warning(`knowledge/ 目录下未找到 ${file}，请确认文件已放入`)
    return
  }
  docs.value = [...docs.value, { file, title: draft.title.trim() || file, updatedAt: nowStamp() }]
  await persistIndex()
  ElMessage.success('已登记')
  registering.value = null
}

defineExpose({ load, openNew, openEdit, saveEdit, offShelf, openRegister, saveRegister, registering, editing })

const listEmpty = computed(() => !loading.value && docs.value.length === 0)
onMounted(() => {
  if (available) void load()
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
