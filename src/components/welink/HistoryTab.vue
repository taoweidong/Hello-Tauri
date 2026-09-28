<script setup lang="ts">
/**
 * Tab「回复历史」（设计 §11.3，R3）—— 任务全生命周期 + 拦截审计。
 *
 * 这一页是「机制级仪表盘」：不只看到回了什么，更看到**本可以发但被拦下的每一次**
 * （skipped + skip_reason）与**等你处理的任务**（hold_reason，O7 的落地页）。
 *
 * 行操作：
 *  * failed → 「重发」（回 ready 入队，重发同样过 Gate）
 *  * ready(manual) → 「编辑并发送」弹层（人工发送也检查 S7 黑名单，
 *    命中需勾选「我确认无误发风险」）
 *  * 「查看调用」→ 跳 Tab4 过滤到该 job
 *
 * 评价（O10）：sent 行加 👍/👎，差评对就是改进语料。
 */
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'

import { IconRefresh } from '@/components/icons'
import { useAppStore } from '@/stores/app'
import { useWelinkStore } from '@/stores/welink'
import { JOB_STATUS_LABEL, JOB_STATUS_TONE } from '@/infra/db/ports'
import type { JobStatus, WelinkJob } from '@/types/welink'
import { rowOf } from '@/utils/table'
import { shortStamp } from '@/utils/welink-display'

const props = defineProps<{ preset: { onlyHolding?: boolean; onlySkipped?: boolean; targetId?: string } | null }>()
const emit = defineEmits<{ (e: 'preset-consumed'): void; (e: 'open-trace', jobPk: number): void }>()

const store = useWelinkStore()
const appStore = useAppStore()

/**
 * `<el-table>` 插槽行的业务类型收窄（根因见 `utils/table.ts`）。
 * 上游 `el-table-column` 的插槽签名硬编码为 `DefaultRow`，不做泛型推断。
 */
const jobOf = (row: unknown): WelinkJob => rowOf<WelinkJob>(row)

/**
 * `el-tag` 的 `type` 只接受 `info | primary | success | warning | danger`，
 * 而状态色调表里的 `muted`（已拦截）是**本项目自有的中性色**语义，
 * 在 el-tag 中没有对应值，统一降级为 `info`（灰蓝中性，视觉意图一致）。
 */
type TagType = 'info' | 'primary' | 'success' | 'warning' | 'danger'
function tagTypeOf(status: JobStatus): TagType {
  const tone = JOB_STATUS_TONE[status]
  return tone === 'muted' ? 'info' : tone
}

const filter = reactive({
  status: [] as JobStatus[],
  triggerType: [] as string[],
  targetId: '',
  onlySkipped: false,
  onlyHolding: false,
  onlyDownRated: false,
  from: '',
  to: '',
})

const rows = ref<WelinkJob[]>([])
const total = ref(0)
const page = ref(1)
const loading = ref(false)
const stats = ref({ todayCount: 0, sentCount: 0, failedCount: 0, successRate: 1, avgLatencySec: 0, skippedCount: 0 })

const pageSize = computed(() => appStore.settings.pageSize || 10)

/**
 * 目标会话候选（§11.3 筛选器）：来自已配置会话清单。
 * 用 convId 作值（与 job.targetId 同口径），title 存在时拼上便于辨识。
 */
const targetOptions = computed(() => store.conversations.map((item) => ({ convId: item.convId, title: item.title })))

const statusOptions: JobStatus[] = ['pending', 'discussing', 'ready', 'sending', 'sent', 'failed', 'skipped']
const triggerOptions = [
  { value: 'group_at_me', label: '群 @我' },
  { value: 'private', label: '私聊' },
  { value: 'manual', label: '手动' },
]

const query = computed(() => ({
  status: filter.status.length ? filter.status : undefined,
  triggerType: filter.triggerType.length ? (filter.triggerType as never) : undefined,
  targetId: filter.targetId || undefined,
  onlySkipped: filter.onlySkipped || undefined,
  onlyHolding: filter.onlyHolding || undefined,
  onlyDownRated: filter.onlyDownRated || undefined,
  from: filter.from ? `${filter.from} 00:00:00` : undefined,
  to: filter.to ? `${filter.to} 23:59:59` : undefined,
}))

async function load() {
  loading.value = true
  try {
    const limit = pageSize.value
    rows.value = await store.listJobs({ ...query.value, limit, offset: (page.value - 1) * limit })
    total.value = await store.countJobs(query.value)
    stats.value = await store.jobStats()
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '加载回复历史失败')
  } finally {
    loading.value = false
  }
}

function resetFilters() {
  filter.status = []
  filter.triggerType = []
  filter.targetId = ''
  filter.onlySkipped = false
  filter.onlyHolding = false
  filter.onlyDownRated = false
  filter.from = ''
  filter.to = ''
  page.value = 1
  void load()
}

watch(page, () => void load())

watch(
  () => [
    filter.status,
    filter.triggerType,
    filter.targetId,
    filter.onlySkipped,
    filter.onlyHolding,
    filter.onlyDownRated,
    filter.from,
    filter.to,
  ],
  () => {
    page.value = 1
    void load()
  },
  { deep: true },
)

// 外部预设（O7 待审徽标 / 熔断横幅 / 消息中心跳转）—— 消费后通知父级清空，避免来回覆盖用户筛选
watch(
  () => props.preset,
  (presetValue) => {
    if (!presetValue) return
    if (presetValue.onlyHolding) {
      filter.onlyHolding = true
      filter.onlySkipped = false
      filter.onlyDownRated = false
      filter.status = []
    }
    if (presetValue.onlySkipped) {
      filter.onlySkipped = true
      filter.onlyHolding = false
      filter.onlyDownRated = false
      filter.status = []
    }
    if (presetValue.targetId) {
      filter.targetId = presetValue.targetId
      filter.onlyHolding = false
    }
    page.value = 1
    void load()
    emit('preset-consumed')
  },
  { immediate: true, deep: true },
)

onMounted(load)

// ---------------- 行操作 ----------------

async function retry(job: WelinkJob) {
  const ok = await store.retryJob(job.pk)
  ElMessage[ok ? 'success' : 'error'](ok ? '已重新入队（重发同样经过安全闸口）' : '重发未生效：草稿为空或状态不允许')
  void load()
}

const editDialog = reactive({ open: false, jobPk: 0, text: '', risk: false, hit: false })

function openEdit(job: WelinkJob) {
  editDialog.open = true
  editDialog.jobPk = job.pk
  editDialog.text = job.draft
  editDialog.risk = false
  // 黑名单校验对象 = 即将发出的正文（草稿）；草稿为空时退回触发消息原文，
  // 避免「未改稿直接发」绕过 S7。
  editDialog.hit = matchesBlacklist(job.draft || job.triggerSummary)
}

function matchesBlacklist(text: string): boolean {
  for (const pattern of store.settings.safety.blacklistPatterns) {
    if (!pattern.trim()) continue
    try {
      if (new RegExp(pattern, 'i').test(text)) return true
    } catch {
      // 用户手写正则可能语法错误，跳过该项
    }
  }
  return false
}

async function confirmEdit() {
  if (!editDialog.text.trim()) {
    ElMessage.warning('草稿不能为空')
    return
  }
  if (editDialog.hit && !editDialog.risk) {
    ElMessage.warning('内容命中敏感句式，请勾选「我确认无误发风险」')
    return
  }
  const ok = await store.editAndSend(editDialog.jobPk, editDialog.text)
  editDialog.open = false
  ElMessage[ok ? 'success' : 'error'](ok ? '已提交发送' : '发送未生效，请查看日志')
  void load()
}

/** 仅删除任务记录（触发消息保留）—— 仓储提供的是显式语义方法，这里如实提示 */
async function removeJob(job: WelinkJob) {
  const confirmed = await ElMessageBox.confirm(
    '仅删除这条回复任务记录（触发消息与存档会话保留）。删除后该任务的审计轨迹不可恢复。',
    '删除任务记录',
    { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' },
  ).catch(() => false)
  if (confirmed === false) return
  await store.removeJob(job.pk)
  ElMessage.success('已删除任务记录')
  void load()
}

async function rate(job: WelinkJob, rating: 'up' | 'down') {
  const next = job.rating === rating ? null : rating
  await store.rateJob(job.pk, next)
  if (next === 'down') ElMessage.info('已标记为差评：该输入输出对将出现在回溯页「只看差评」')
}

const expandedDraft = ref<number[]>([])
function toggleDraft(pk: number) {
  expandedDraft.value = expandedDraft.value.includes(pk)
    ? expandedDraft.value.filter((item) => item !== pk)
    : [...expandedDraft.value, pk]
}

/** 复制草稿（模板里拿不到 navigator，收成一个方法） */
function copyDraft(text: string) {
  void navigator.clipboard?.writeText(text)
  ElMessage.success('已复制草稿')
}

const TRIGGER_LABEL: Record<string, string> = { group_at_me: '群 @我', private: '私聊', manual: '手动' }

const timeLabel = (stamp: string | null) => shortStamp(stamp)

/** 耗时（finished_at − created_at，秒） */
function latency(job: WelinkJob): string {
  if (!job.finishedAt) return '-'
  const start = new Date(job.createdAt.replace(' ', 'T')).getTime()
  const end = new Date(job.finishedAt.replace(' ', 'T')).getTime()
  if (!Number.isFinite(start) || !Number.isFinite(end)) return '-'
  return `${Math.max(0, Math.round((end - start) / 1000))}s`
}
</script>

<template>
  <div class="hist">
    <!-- 统计条（R3 机制级仪表盘） -->
    <div class="hist__stats">
      <div class="stat">
        <span class="stat__label">今日处理</span>
        <span class="stat__value num">{{ stats.todayCount }}</span>
      </div>
      <div class="stat">
        <span class="stat__label">成功率</span>
        <span class="stat__value num">{{ (stats.successRate * 100).toFixed(0) }}%</span>
      </div>
      <div class="stat">
        <span class="stat__label">平均耗时</span>
        <span class="stat__value num">{{ stats.avgLatencySec }}s</span>
      </div>
      <div class="stat">
        <span class="stat__label">失败待处理</span>
        <span class="stat__value num is-danger">{{ stats.failedCount }}</span>
      </div>
      <div class="stat">
        <span class="stat__label">被拦 m 条</span>
        <span class="stat__value num is-muted">{{ stats.skippedCount }}</span>
      </div>
      <div class="stat">
        <span class="stat__label">本小时已发</span>
        <span class="stat__value num">{{ store.safety.globalCount }}/{{ store.safety.globalCap }}</span>
      </div>
    </div>

    <!-- 筛选器 -->
    <div class="hist__filter">
      <el-select v-model="filter.status" multiple collapse-tags placeholder="状态" size="small" class="hist__sel">
        <el-option v-for="item in statusOptions" :key="item" :label="JOB_STATUS_LABEL[item]" :value="item" />
      </el-select>
      <el-select
        v-model="filter.triggerType"
        multiple
        collapse-tags
        placeholder="触发类型"
        size="small"
        class="hist__sel"
      >
        <el-option v-for="item in triggerOptions" :key="item.value" :label="item.label" :value="item.value" />
      </el-select>
      <!-- 目标会话筛选（§11.3）：可搜索下拉，选项来自已配置会话；clearable 便于快速回全量 -->
      <el-select
        v-model="filter.targetId"
        filterable
        clearable
        placeholder="目标会话"
        size="small"
        class="hist__sel hist__sel--wide"
      >
        <el-option
          v-for="item in targetOptions"
          :key="item.convId"
          :label="item.title ? `${item.title}（${item.convId}）` : item.convId"
          :value="item.convId"
        />
      </el-select>
      <el-checkbox v-model="filter.onlySkipped" size="small">仅看被拦截</el-checkbox>
      <el-checkbox v-model="filter.onlyHolding" size="small">待我处理</el-checkbox>
      <el-checkbox v-model="filter.onlyDownRated" size="small">只看差评</el-checkbox>
      <el-date-picker
        v-model="filter.from"
        type="date"
        size="small"
        placeholder="起始"
        value-format="YYYY-MM-DD"
        class="hist__date"
      />
      <el-date-picker
        v-model="filter.to"
        type="date"
        size="small"
        placeholder="截止"
        value-format="YYYY-MM-DD"
        class="hist__date"
      />
      <el-button size="small" :icon="IconRefresh" @click="load()">刷新</el-button>
      <el-button size="small" text @click="resetFilters">重置</el-button>
    </div>

    <!-- 表格 -->
    <el-table v-loading="loading" :data="rows" size="small" class="hist__table" empty-text="没有符合条件的任务">
      <el-table-column label="时间" width="130">
        <template #default="{ row }">
          <div class="cell-time">{{ timeLabel(jobOf(row).createdAt) }}</div>
          <div class="cell-dim">耗时 {{ latency(jobOf(row)) }}</div>
        </template>
      </el-table-column>

      <el-table-column label="触发" width="150">
        <template #default="{ row }">
          <el-tag size="small" effect="plain">{{ TRIGGER_LABEL[row.triggerType] ?? row.triggerType }}</el-tag>
          <div class="cell-dim" :title="row.triggerSummary">{{ row.triggerSummary || '（无摘要）' }}</div>
        </template>
      </el-table-column>

      <el-table-column label="目标" width="150">
        <template #default="{ row }">
          <div>{{ row.targetTitle || row.targetId }}</div>
          <div class="cell-dim mono">{{ row.targetId }}</div>
        </template>
      </el-table-column>

      <el-table-column label="状态" width="140">
        <template #default="{ row }">
          <el-tag size="small" :type="tagTypeOf(row.status as JobStatus)" effect="light">
            {{ store.statusLabel(row.status) }}
          </el-tag>
          <div v-if="row.skipReason" class="cell-reason" :title="store.skipLabel(row.skipReason)">
            {{ store.skipLabel(row.skipReason) }}
          </div>
          <div v-else-if="row.holdReason" class="cell-reason is-hold">{{ store.holdLabel(row.holdReason) }}</div>
        </template>
      </el-table-column>

      <el-table-column label="草稿" min-width="220">
        <template #default="{ row }">
          <div
            v-if="row.draft"
            class="cell-draft"
            :class="{ 'is-open': expandedDraft.includes(row.pk) }"
            @click="toggleDraft(row.pk)"
          >
            {{ row.draft }}
          </div>
          <span v-else class="cell-dim">（无草稿）</span>
          <div v-if="row.draft" class="cell-actions">
            <button class="link" @click="toggleDraft(row.pk)">
              {{ expandedDraft.includes(row.pk) ? '收起' : '展开全文' }}
            </button>
            <button class="link" @click="copyDraft(row.draft)">复制</button>
          </div>
        </template>
      </el-table-column>

      <el-table-column label="重试" width="90">
        <template #default="{ row }">
          <span class="num">{{ row.attempts }}</span>
          <div v-if="row.lastError" class="cell-dim" :title="row.lastError">{{ row.lastError.slice(0, 22) }}…</div>
        </template>
      </el-table-column>

      <el-table-column label="评价" width="80" align="center">
        <template #default="{ row }">
          <button
            class="rate pressable"
            :class="{ 'is-on': row.rating === 'up' }"
            title="回复可采纳"
            @click="rate(jobOf(row), 'up')"
          >
            👍
          </button>
          <button
            class="rate pressable"
            :class="{ 'is-on': row.rating === 'down' }"
            title="回复需改进（差评对是改进语料）"
            @click="rate(jobOf(row), 'down')"
          >
            👎
          </button>
        </template>
      </el-table-column>

      <el-table-column label="调用" width="78" align="center">
        <template #default="{ row }">
          <!-- R4 联动：只有真正走到模型调用阶段的任务才有回溯语料 -->
          <button
            v-if="row.status !== 'pending' && row.status !== 'skipped'"
            class="link"
            title="查看该任务的模型输入输出"
            @click="emit('open-trace', row.pk)"
          >
            查看调用
          </button>
          <span v-else class="cell-dim">-</span>
        </template>
      </el-table-column>

      <el-table-column label="操作" width="170" fixed="right">
        <template #default="{ row }">
          <el-button
            v-if="row.status === 'failed' || row.status === 'skipped'"
            size="small"
            text
            type="primary"
            @click="retry(jobOf(row))"
          >
            重发
          </el-button>
          <el-button v-if="row.status === 'ready'" size="small" text type="primary" @click="openEdit(jobOf(row))"
            >编辑并发送</el-button
          >
          <el-button size="small" text @click="removeJob(jobOf(row))">删除</el-button>
        </template>
      </el-table-column>
    </el-table>

    <div class="hist__pager">
      <el-pagination
        v-model:current-page="page"
        :page-size="pageSize"
        :total="total"
        layout="total, prev, pager, next"
        size="small"
        background
      />
    </div>

    <!-- 编辑并发送弹层 -->
    <el-dialog v-model="editDialog.open" title="编辑并发送" width="560px">
      <p class="dialog__hint">人工发送同样经过安全闸口（开关 / 频控 / 黑名单），命中敏感句式需显式确认。</p>
      <el-input
        v-model="editDialog.text"
        type="textarea"
        :rows="7"
        maxlength="500"
        show-word-limit
        placeholder="确认或修改后发送"
      />
      <el-alert
        v-if="editDialog.hit"
        class="dialog__alert"
        type="error"
        :closable="false"
        show-icon
        title="命中敏感句式黑名单"
        description="内容可能包含资金/凭据类承诺或索要，请人工确认无误发风险。"
      />
      <el-checkbox v-if="editDialog.hit" v-model="editDialog.risk" class="dialog__risk">我确认无误发风险</el-checkbox>
      <template #footer>
        <el-button @click="editDialog.open = false">取消</el-button>
        <el-button type="primary" :disabled="editDialog.hit && !editDialog.risk" @click="confirmEdit"
          >确认发送</el-button
        >
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.hist {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px 14px 16px;
}

.hist__stats {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

.stat {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 8px 14px;
  border: 1px solid var(--ht-line);
  border-radius: var(--ht-radius-sm);
  background: var(--ht-surface);
  min-width: 96px;
}

.stat__label {
  font-size: 11px;
  color: var(--ht-text-3);
}

.stat__value {
  font-size: 15px;
  font-weight: 600;
  color: var(--ht-text-1);
}

.stat__value.is-danger {
  color: var(--ht-danger);
}

.stat__value.is-muted {
  color: var(--ht-text-3);
}

.hist__filter {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.hist__sel {
  width: 150px;
}

/* 目标会话：标题 + 会话号的组合文案更长，给宽一点 */
.hist__sel--wide {
  width: 200px;
}

.hist__date {
  width: 138px;
}

.hist__table {
  border: 1px solid var(--ht-line);
  border-radius: var(--ht-radius-sm);
}

.cell-time {
  font-variant-numeric: tabular-nums;
}

.cell-dim {
  font-size: 11px;
  color: var(--ht-text-3);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 100%;
}

.cell-reason {
  margin-top: 3px;
  font-size: 11px;
  color: var(--ht-text-3);
}

.cell-reason.is-hold {
  color: var(--ht-warn);
  font-weight: 600;
}

.cell-draft {
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  font-size: 12.5px;
  line-height: 1.6;
  color: var(--ht-text-1);
  cursor: pointer;
  overflow-wrap: anywhere;
}

.cell-draft.is-open {
  -webkit-line-clamp: unset;
  white-space: pre-wrap;
}

.cell-actions {
  display: flex;
  gap: 10px;
  margin-top: 4px;
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

.rate {
  border: 1px solid transparent;
  border-radius: 6px;
  background: transparent;
  font-size: 13px;
  line-height: 1;
  padding: 3px 4px;
  cursor: pointer;
  filter: grayscale(1);
  opacity: 0.5;
}

.rate.is-on {
  filter: none;
  opacity: 1;
  border-color: var(--ht-line-strong);
  background: var(--ht-surface-2);
}

.hist__pager {
  display: flex;
  justify-content: flex-end;
}

.dialog__hint {
  margin: 0 0 10px;
  font-size: 12px;
  color: var(--ht-text-3);
  line-height: 1.7;
}

.dialog__alert {
  margin-top: 10px;
}

.dialog__risk {
  margin-top: 8px;
}
</style>
