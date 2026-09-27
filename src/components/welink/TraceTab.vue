<script setup lang="ts">
/**
 * Tab「Agent 回溯」（设计 §11.4，R4）—— 主从布局：左 job 列表 ｜ 右调用明细。
 *
 * 这一页存在的唯一理由是**改进闭环**：只看「回复发出去了」无法判断模型好坏，
 * 必须能看到「喂了什么提示词 → 模型吐了什么 → 最终发出的是什么」。
 * 因此右栏的对比区专门标出「人工改过稿」，差评对（👎）就是最直接的改进语料。
 *
 * 隐私边界（设计 §10）：prompt/response 含完整对话原文，所以提供
 *  * 单 job「导出 JSON」（离线分析，Q6 只做单 job，不做批量）
 *  * 「清理回溯记录」（只删留痕，任务与消息保留）
 */
import { computed, onMounted, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'

import { IconDownload, IconRefresh, IconTrash } from '@/components/icons'
import { useWelinkStore } from '@/stores/welink'
import type { AgentLogStatus, WelinkAgentLog, WelinkJob } from '@/types/welink'

const props = defineProps<{ focusJobPk?: number | null }>()
const emit = defineEmits<{ (e: 'focus-consumed'): void }>()

const store = useWelinkStore()

const jobs = ref<WelinkJob[]>([])
const total = ref(0)
const page = ref(1)
const pageSize = 50
const loading = ref(false)
const selectedJobPk = ref<number | null>(null)
const logs = ref<WelinkAgentLog[]>([])
const logsLoading = ref(false)

const filter = reactive({ onlyDownRated: false, status: [] as AgentLogStatus[], from: '', to: '' })

/** 展开全文的 prompt/response 卡片（seq 集合） */
const expanded = ref<number[]>([])
function toggleExpand(seq: number) {
  expanded.value = expanded.value.includes(seq) ? expanded.value.filter((item) => item !== seq) : [...expanded.value, seq]
}

const selectedJob = computed(() => jobs.value.find((item) => item.pk === selectedJobPk.value) ?? null)

/** 客户端按状态/时间过滤日志（单 job 的日志条数极少，无需下推到 SQL） */
const visibleLogs = computed(() =>
  logs.value.filter((log) => {
    if (filter.status.length && !filter.status.includes(log.status)) return false
    if (filter.from && log.createdAt < filter.from) return false
    if (filter.to && log.createdAt > `${filter.to} 23:59:59`) return false
    return true
  }),
)

async function loadJobs() {
  loading.value = true
  try {
    jobs.value = await store.listJobsWithLogs(pageSize, (page.value - 1) * pageSize, filter.onlyDownRated)
    total.value = await store.countJobsWithLogs(filter.onlyDownRated)
    await ensureSelection()
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '加载回溯列表失败')
  } finally {
    loading.value = false
  }
}

/** 选中态必须在列表刷新后仍然有效，否则右栏会停在一条已不在列表里的 job 上 */
async function ensureSelection() {
  const focused = props.focusJobPk
  if (focused && jobs.value.some((item) => item.pk === focused)) {
    await selectJob(focused)
    emit('focus-consumed')
    return
  }
  if (selectedJobPk.value && jobs.value.some((item) => item.pk === selectedJobPk.value)) return
  if (jobs.value.length) await selectJob(jobs.value[0].pk)
  else {
    selectedJobPk.value = null
    logs.value = []
  }
}

async function selectJob(jobPk: number) {
  selectedJobPk.value = jobPk
  logsLoading.value = true
  try {
    logs.value = await store.listAgentLogs(jobPk)
    expanded.value = []
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '加载调用明细失败')
  } finally {
    logsLoading.value = false
  }
}

function resetFilters() {
  filter.onlyDownRated = false
  filter.status = []
  filter.from = ''
  filter.to = ''
  page.value = 1
  void loadJobs()
}

// —— 导出（Q6：单 job，含输入输出） ——

function exportJob() {
  const job = selectedJob.value
  if (!job) return
  const payload = {
    exportedAt: new Date().toISOString(),
    job: {
      pk: job.pk,
      triggerType: job.triggerType,
      targetId: job.targetId,
      targetTitle: job.targetTitle,
      status: job.status,
      rating: job.rating,
      triggerSummary: job.triggerSummary,
      finalDraft: job.draft,
      createdAt: job.createdAt,
      finishedAt: job.finishedAt,
    },
    calls: logs.value.map((log) => ({
      seq: log.seq,
      status: log.status,
      latencyMs: log.latencyMs,
      createdAt: log.createdAt,
      error: log.error,
      prompt: log.prompt,
      response: log.response,
    })),
  }
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `welink-trace-job-${job.pk}.json`
  link.click()
  URL.revokeObjectURL(url)
  ElMessage.success(`已导出 job ${job.pk} 的 ${logs.value.length} 条调用记录`)
}

async function clearLogs() {
  const job = selectedJob.value
  if (!job) return
  const confirmed = await ElMessageBox.confirm(
    `将删除 job ${job.pk} 的全部 ${logs.value.length} 条模型调用记录（提示词与回复原文）。任务本身与消息存档保留，但该次调用无法再复现。`,
    '清理回溯记录',
    { type: 'warning', confirmButtonText: '清理', cancelButtonText: '取消' },
  ).catch(() => false)
  if (confirmed === false) return
  const removed = await store.clearAgentLogs(job.pk)
  await loadJobs()
  ElMessage.success(`已清理 ${removed} 条记录`)
}

// —— 展示辅助 ——

const STATUS_LABEL: Record<AgentLogStatus, string> = { ok: '成功', error: '错误', timeout: '超时' }
const STATUS_TONE: Record<AgentLogStatus, 'success' | 'danger' | 'warning'> = {
  ok: 'success',
  error: 'danger',
  timeout: 'warning',
}
const TRIGGER_LABEL: Record<string, string> = { group_at_me: '群 @我', private: '私聊', manual: '手动' }

const timeLabel = (stamp: string | null) => (stamp ? stamp.slice(5, 16) : '-')
/** prompt 折叠时只显示前 5 行（§11.4） */
const previewOf = (text: string, lines = 5) => text.split('\n').slice(0, lines).join('\n')

function copy(text: string) {
  void navigator.clipboard?.writeText(text)
  ElMessage.success('已复制')
}

onMounted(loadJobs)
</script>

<template>
  <div class="trace">
    <!-- 筛选器 -->
    <div class="trace__filter">
      <el-checkbox v-model="filter.onlyDownRated" size="small">只看差评</el-checkbox>
      <el-select v-model="filter.status" multiple collapse-tags placeholder="调用状态" size="small" class="trace__sel">
        <el-option v-for="(label, key) in STATUS_LABEL" :key="key" :label="label" :value="key" />
      </el-select>
      <el-date-picker v-model="filter.from" type="date" size="small" placeholder="起始" value-format="YYYY-MM-DD" class="trace__date" />
      <el-date-picker v-model="filter.to" type="date" size="small" placeholder="截止" value-format="YYYY-MM-DD" class="trace__date" />
      <el-button size="small" :icon="IconRefresh" @click="loadJobs()">刷新</el-button>
      <el-button size="small" text @click="resetFilters">重置</el-button>
      <span class="spacer" />
      <span class="trace__hint">共 {{ total }} 个有调用记录的任务</span>
    </div>

    <div class="trace__body">
      <!-- 左：job 列表 -->
      <aside class="trace__list" v-loading="loading">
        <button
          v-for="job in jobs"
          :key="job.pk"
          class="tjob pressable"
          :class="{ 'is-active': job.pk === selectedJobPk }"
          @click="selectJob(job.pk)"
        >
          <span class="tjob__row">
            <span class="tjob__time">{{ timeLabel(job.createdAt) }}</span>
            <el-tag size="small" effect="plain">{{ TRIGGER_LABEL[job.triggerType] ?? job.triggerType }}</el-tag>
            <span v-if="job.rating === 'down'" class="tjob__down" title="差评">👎</span>
          </span>
          <span class="tjob__title">{{ job.targetTitle || job.targetId }}</span>
          <span class="tjob__summary">{{ job.triggerSummary || job.draft || '（无摘要）' }}</span>
        </button>
        <p v-if="!jobs.length && !loading" class="trace__empty">暂无可回溯的调用记录</p>
        <div v-if="total > pageSize" class="trace__pager">
          <el-pagination v-model:current-page="page" :page-size="pageSize" :total="total" layout="prev, pager, next" small background @current-change="loadJobs()" />
        </div>
      </aside>

      <!-- 右：调用明细 -->
      <section class="trace__detail" v-loading="logsLoading">
        <header class="trace__detail-head">
          <template v-if="selectedJob">
            <span class="trace__detail-title">job {{ selectedJob.pk }} · {{ selectedJob.targetTitle || selectedJob.targetId }}</span>
            <el-tag size="small" effect="plain">{{ visibleLogs.length }} 次调用</el-tag>
          </template>
          <span v-else class="trace__hint">请选择左侧任务</span>
          <span class="spacer" />
          <el-button v-if="selectedJob" size="small" :icon="IconDownload" :disabled="!logs.length" @click="exportJob">导出 JSON</el-button>
          <el-button v-if="selectedJob" size="small" text type="danger" :icon="IconTrash" :disabled="!logs.length" @click="clearLogs">
            清理记录
          </el-button>
        </header>

        <div v-if="selectedJob" class="trace__stream">
          <!-- 最终草稿 vs 模型输出（人工编辑标记） -->
          <div v-if="selectedJob.draft" class="final">
            <span class="final__label">最终发出的草稿</span>
            <p class="final__text">{{ selectedJob.draft }}</p>
            <span v-if="logs.length && logs[logs.length - 1].response.trim() !== selectedJob.draft.trim()" class="final__edited">
              已人工编辑（模型输出与最终草稿不一致）
            </span>
          </div>

          <article v-for="log in visibleLogs" :key="log.seq" class="call">
            <header class="call__head">
              <span class="call__seq">#{{ log.seq }}</span>
              <el-tag size="small" :type="STATUS_TONE[log.status]" effect="light">{{ STATUS_LABEL[log.status] }}</el-tag>
              <span class="call__meta num">{{ log.latencyMs }} ms</span>
              <span class="call__meta">{{ timeLabel(log.createdAt) }}</span>
            </header>

            <!-- 输入区 -->
            <div class="call__block">
              <div class="call__block-head">
                <span class="call__label">输入（prompt）</span>
                <span class="spacer" />
                <button class="link" @click="toggleExpand(log.seq)">
                  {{ expanded.includes(log.seq) ? '收起' : '展开全文' }}
                </button>
                <button class="link" @click="copy(log.prompt)">复制</button>
              </div>
              <pre class="call__code" :class="{ 'is-open': expanded.includes(log.seq) }">{{
                expanded.includes(log.seq) ? log.prompt : previewOf(log.prompt)
              }}</pre>
              <span v-if="!expanded.includes(log.seq) && log.prompt.split('\n').length > 5" class="call__more">
                … 共 {{ log.prompt.split('\n').length }} 行
              </span>
            </div>

            <!-- 输出区 -->
            <div class="call__block">
              <div class="call__block-head">
                <span class="call__label">输出（response）</span>
                <span class="spacer" />
                <button v-if="log.response" class="link" @click="copy(log.response)">复制</button>
              </div>
              <pre v-if="log.response" class="call__code is-response" :class="{ 'is-open': expanded.includes(log.seq) }">{{
                expanded.includes(log.seq) ? log.response : previewOf(log.response)
              }}</pre>
              <p v-else class="call__none">（本次调用没有返回内容）</p>
            </div>

            <el-alert v-if="log.error" type="error" :closable="false" show-icon :title="log.error" class="call__error" />
          </article>

          <p v-if="!visibleLogs.length" class="trace__empty">该任务暂无符合条件的调用记录</p>
        </div>

        <p v-else class="trace__empty">选择左侧任务查看模型输入输出明细</p>
      </section>
    </div>

    <p class="trace__note">
      回溯记录包含完整对话原文，属于敏感数据；仅用于改进回复质量，可按任务清理或导出后离线分析。
    </p>
  </div>
</template>

<style scoped>
.trace {
  display: flex;
  flex-direction: column;
  min-height: 420px;
}

.trace__filter {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--ht-line);
  flex-wrap: wrap;
}

.trace__sel {
  width: 168px;
}

.trace__date {
  width: 138px;
}

.trace__hint {
  font-size: 11.5px;
  color: var(--ht-text-3);
}

.spacer {
  flex: 1;
}

.trace__body {
  display: grid;
  grid-template-columns: 300px minmax(0, 1fr);
  flex: 1;
  min-height: 0;
}

.trace__list {
  border-right: 1px solid var(--ht-line);
  overflow-y: auto;
  padding: 8px;
}

.tjob {
  display: flex;
  flex-direction: column;
  gap: 4px;
  width: 100%;
  padding: 8px 10px;
  border: none;
  border-radius: var(--ht-radius-sm);
  background: transparent;
  color: var(--ht-text-1);
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.tjob:hover {
  background: var(--ht-surface-2);
}

.tjob.is-active {
  background: var(--ht-primary-soft);
}

.tjob__row {
  display: flex;
  align-items: center;
  gap: 6px;
}

.tjob__time {
  font-size: 11px;
  color: var(--ht-text-3);
  font-variant-numeric: tabular-nums;
}

.tjob__down {
  font-size: 12px;
}

.tjob__title {
  font-size: 12.5px;
  font-weight: 500;
}

.tjob__summary {
  font-size: 11.5px;
  color: var(--ht-text-3);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.trace__pager {
  display: flex;
  justify-content: center;
  padding: 8px 0;
}

.trace__detail {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.trace__detail-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--ht-line);
}

.trace__detail-title {
  font-size: 12.5px;
  font-weight: 600;
}

.trace__stream {
  flex: 1;
  overflow-y: auto;
  padding: 12px 14px 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.final {
  position: relative;
  padding: 10px 12px;
  border: 1px solid var(--ht-primary-line);
  border-radius: var(--ht-radius-sm);
  background: var(--ht-primary-soft);
}

.final__label {
  font-size: 11px;
  font-weight: 600;
  color: var(--ht-primary);
}

.final__text {
  margin: 6px 0 0;
  font-size: 13px;
  line-height: 1.7;
  color: var(--ht-text-1);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.final__edited {
  display: inline-block;
  margin-top: 8px;
  font-size: 11px;
  color: var(--ht-warn);
  font-weight: 600;
}

.call {
  border: 1px solid var(--ht-line);
  border-radius: var(--ht-radius-sm);
  padding: 10px 12px;
  background: var(--ht-surface);
}

.call__head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}

.call__seq {
  font-size: 12px;
  font-weight: 600;
  color: var(--ht-text-2);
  font-variant-numeric: tabular-nums;
}

.call__meta {
  font-size: 11px;
  color: var(--ht-text-3);
}

.call__block + .call__block {
  margin-top: 10px;
}

.call__block-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 4px;
}

.call__label {
  font-size: 11px;
  font-weight: 600;
  color: var(--ht-text-2);
}

.call__code {
  margin: 0;
  padding: 8px 10px;
  border-radius: 6px;
  background: var(--ht-surface-2);
  color: var(--ht-text-1);
  font-family: var(--ht-font-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace);
  font-size: 11.5px;
  line-height: 1.6;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  max-height: 120px;
  overflow: hidden;
}

.call__code.is-open {
  max-height: 460px;
  overflow: auto;
}

.call__code.is-response {
  border-left: 2px solid var(--ht-primary);
}

.call__more {
  font-size: 11px;
  color: var(--ht-text-3);
}

.call__none {
  margin: 0;
  font-size: 11.5px;
  color: var(--ht-text-3);
}

.call__error {
  margin-top: 8px;
}

.link {
  border: none;
  background: transparent;
  color: var(--ht-primary);
  font: inherit;
  font-size: 11.5px;
  cursor: pointer;
  padding: 0;
}

.trace__empty {
  padding: 24px 14px;
  text-align: center;
  font-size: 12px;
  color: var(--ht-text-3);
}

.trace__note {
  margin: 0;
  padding: 9px 14px;
  border-top: 1px solid var(--ht-line);
  font-size: 11.5px;
  color: var(--ht-text-3);
}
</style>