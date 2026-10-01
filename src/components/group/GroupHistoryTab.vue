<script setup lang="ts">
/**
 * Tab「建群历史」（migration v3）—— 建群任务全生命周期留痕。
 *
 * 每一行都是一次对外动作的凭据：pending = 外呼进行中；success 带群 ID；
 * failed 带错误全文；interrupted = 上一会话中断、结局未知（启动清扫的产物）。
 * 成员清单与错误详情放展开行 —— 列表保持一屏可扫，细节按需查看。
 */
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'

import { IconRefresh } from '@/components/icons'
import { useAppStore } from '@/stores/app'
import { useGroupStore } from '@/stores/group'
import { GROUP_JOB_STATUS_LABEL, GROUP_JOB_STATUS_TONE } from '@/infra/db/group-ports'
import { isLocalGroupId } from '@/infra/welink/adapter'
import type { GroupJob, GroupJobStatus } from '@/types/welink'
import { rowOf } from '@/utils/table'
import { shortStamp } from '@/utils/welink-display'

const store = useGroupStore()
const appStore = useAppStore()

/** el-tag 的 type 收窄：muted 是本项目自有的中性色语义，el-tag 无对应值，降级 info */
type TagType = 'info' | 'primary' | 'success' | 'warning' | 'danger'
function tagTypeOf(status: GroupJobStatus): TagType {
  const tone = GROUP_JOB_STATUS_TONE[status]
  return tone === 'muted' ? 'info' : tone
}

const jobOf = (row: unknown): GroupJob => rowOf<GroupJob>(row)

const filter = reactive({
  status: [] as GroupJobStatus[],
  keyword: '',
  from: '',
  to: '',
})

const rows = ref<GroupJob[]>([])
const total = ref(0)
const page = ref(1)
const loading = ref(false)

const pageSize = computed(() => appStore.settings.pageSize || 10)
const statusOptions: GroupJobStatus[] = ['pending', 'success', 'failed', 'interrupted']

const query = computed(() => ({
  status: filter.status.length ? filter.status : undefined,
  keyword: filter.keyword || undefined,
  from: filter.from ? `${filter.from} 00:00:00` : undefined,
  to: filter.to ? `${filter.to} 23:59:59` : undefined,
}))

async function load() {
  loading.value = true
  try {
    const limit = pageSize.value
    rows.value = await store.listJobs({ ...query.value, limit, offset: (page.value - 1) * limit })
    total.value = await store.countJobs(query.value)
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '加载建群历史失败')
  } finally {
    loading.value = false
  }
}

function resetFilters() {
  filter.status = []
  filter.keyword = ''
  filter.from = ''
  filter.to = ''
  page.value = 1
  void load()
}

watch(page, () => void load())
watch(
  () => [filter.status, filter.keyword, filter.from, filter.to],
  () => {
    page.value = 1
    void load()
  },
  { deep: true },
)

// 建群/删记录（其它 Tab 发起）→ 版本号自增 → 这里重载当前页
watch(
  () => store.historyVersion,
  () => void load(),
)

async function remove(row: unknown) {
  const job = jobOf(row)
  const confirmed = await ElMessageBox.confirm(
    `删除「${job.groupName}」的这条建群记录？只删留痕，不影响已建成的群。`,
    '删除记录',
    { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' },
  ).catch(() => false)
  if (confirmed === false) return
  try {
    await store.removeJob(job.pk)
    ElMessage.success('已删除记录')
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '删除记录失败')
  }
}

onMounted(() => {
  void load()
})
</script>

<template>
  <div class="ghist">
    <div class="ghist__filter">
      <el-select v-model="filter.status" multiple collapse-tags placeholder="状态" size="small" class="ghist__sel">
        <el-option v-for="item in statusOptions" :key="item" :label="GROUP_JOB_STATUS_LABEL[item]" :value="item" />
      </el-select>
      <el-input
        v-model="filter.keyword"
        size="small"
        clearable
        placeholder="搜群名称 / 模板 / 工号"
        class="ghist__keyword"
      />
      <el-date-picker
        v-model="filter.from"
        type="date"
        size="small"
        placeholder="起始"
        value-format="YYYY-MM-DD"
        class="ghist__date"
      />
      <el-date-picker
        v-model="filter.to"
        type="date"
        size="small"
        placeholder="截止"
        value-format="YYYY-MM-DD"
        class="ghist__date"
      />
      <el-button size="small" :icon="IconRefresh" @click="load()">刷新</el-button>
      <el-button size="small" text @click="resetFilters">重置</el-button>
    </div>

    <el-table v-loading="loading" :data="rows" size="small" class="ghist__table" empty-text="还没有建群记录">
      <el-table-column type="expand">
        <template #default="{ row }">
          <div class="ghist__detail">
            <div class="ghist__detail-row">
              <span class="ghist__detail-label">成员（{{ jobOf(row).members.length }}）</span>
              <span>{{ jobOf(row).members.join('、') || '—' }}</span>
            </div>
            <div v-if="jobOf(row).error" class="ghist__detail-row">
              <span class="ghist__detail-label">错误信息</span>
              <span class="ghist__detail-error">{{ jobOf(row).error }}</span>
            </div>
            <div v-if="jobOf(row).templateName" class="ghist__detail-row">
              <span class="ghist__detail-label">来源模板</span>
              <span>{{ jobOf(row).templateName }}（#{{ jobOf(row).templatePk ?? '已删' }}）</span>
            </div>
          </div>
        </template>
      </el-table-column>

      <el-table-column label="时间" width="140">
        <template #default="{ row }">
          <div>{{ shortStamp(jobOf(row).createdAt) }}</div>
          <div v-if="jobOf(row).finishedAt" class="cell-dim">完成于 {{ shortStamp(jobOf(row).finishedAt) }}</div>
        </template>
      </el-table-column>

      <el-table-column label="群名称" min-width="170" show-overflow-tooltip>
        <template #default="{ row }">
          <div>{{ jobOf(row).groupName }}</div>
          <div v-if="jobOf(row).groupId" class="cell-dim mono">
            {{ isLocalGroupId(jobOf(row).groupId) ? '本地占位（CLI 未回传群 ID）' : jobOf(row).groupId }}
          </div>
        </template>
      </el-table-column>

      <el-table-column label="模板" width="130" show-overflow-tooltip>
        <template #default="{ row }">{{ jobOf(row).templateName || '手工填写' }}</template>
      </el-table-column>

      <el-table-column label="成员数" width="80" align="center">
        <template #default="{ row }">{{ jobOf(row).members.length }}</template>
      </el-table-column>

      <el-table-column label="状态" width="110">
        <template #default="{ row }">
          <el-tag size="small" :type="tagTypeOf(jobOf(row).status)" effect="light">
            {{ GROUP_JOB_STATUS_LABEL[jobOf(row).status] }}
          </el-tag>
        </template>
      </el-table-column>

      <el-table-column label="操作" width="80" fixed="right">
        <template #default="{ row }">
          <el-button link type="danger" size="small" @click="remove(row)">删除</el-button>
        </template>
      </el-table-column>
    </el-table>

    <div v-if="total > pageSize" class="ghist__pager">
      <el-pagination
        v-model:current-page="page"
        layout="total, prev, pager, next"
        :total="total"
        :page-size="pageSize"
        background
        small
      />
    </div>
  </div>
</template>

<style scoped>
.ghist {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.ghist__filter {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.ghist__sel {
  width: 150px;
}

.ghist__keyword {
  width: 200px;
}

.ghist__date {
  width: 130px;
}

.ghist__detail {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 4px 12px;
  font-size: 12.5px;
  line-height: 1.6;
}

.ghist__detail-row {
  display: flex;
  gap: 10px;
}

.ghist__detail-label {
  flex-shrink: 0;
  width: 70px;
  color: var(--ht-text-3);
}

.ghist__detail-error {
  color: var(--ht-danger);
  word-break: break-all;
}

.ghist__pager {
  display: flex;
  justify-content: flex-end;
}
</style>
