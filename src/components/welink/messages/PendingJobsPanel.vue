<script setup lang="ts">
/**
 * 消息中心右栏：该会话待办回复（自 MessagesTab 拆出，quality-hardening-2026-10 4.1）。
 *
 * failed/skipped → 「重试」回 ready 入队（重发同样过 Gate）；
 * ready + hold_reason（manual 草稿/黑名单转审）→ 「查看草稿」跳回复历史并预设待审筛选。
 */
import { ElMessage } from 'element-plus'

import { useWelinkStore } from '@/stores/welink'
import type { WelinkJob } from '@/types/welink'
import { shortStamp } from '@/utils/welink-display'

const emit = defineEmits<{
  (e: 'open-history', preset: { targetId: string; onlyHolding?: boolean }): void
}>()

const store = useWelinkStore()

async function retryJob(job: WelinkJob) {
  const ok = await store.retryJob(job.pk)
  if (ok) ElMessage.success('已重新入队，将再次通过安全闸口校验')
  else ElMessage.warning('重排失败：该任务状态已变化，请刷新后重试')
}

function openJob(job: WelinkJob) {
  if (job.status === 'ready' && job.holdReason) {
    emit('open-history', { targetId: job.targetId, onlyHolding: true })
    return
  }
  emit('open-history', { targetId: job.targetId })
}

const statusLabel = (job: WelinkJob) => store.statusLabel(job.status)

/** 时间列文案（统一实现，T-4） */
const timeLabel = (stamp: string) => shortStamp(stamp)
</script>

<template>
  <aside class="mc__right">
    <header class="mc__right-head">
      该会话待办
      <span class="mc__count num">{{ store.convJobs.length }}</span>
    </header>
    <div class="mc__jobs">
      <div v-for="job in store.convJobs" :key="job.pk" class="jobcard">
        <div class="jobcard__top">
          <span class="jobcard__status" :class="`is-${job.status}`">{{ statusLabel(job) }}</span>
          <span class="jobcard__time">{{ timeLabel(job.createdAt) }}</span>
        </div>
        <p class="jobcard__summary">{{ job.triggerSummary || '（无摘要）' }}</p>
        <p v-if="job.draft" class="jobcard__draft">{{ job.draft }}</p>
        <div class="jobcard__foot">
          <el-tag v-if="job.holdReason" size="small" type="warning" effect="light">{{
            store.holdLabel(job.holdReason)
          }}</el-tag>
          <el-tag v-if="job.attempts" size="small" type="danger" effect="plain">重试 {{ job.attempts }}</el-tag>
          <span class="spacer" />
          <!-- failed → 直接重试（回 ready 入队，重发同样过 Gate）；ready(manual) → 查看草稿 -->
          <el-button
            v-if="job.status === 'failed' || job.status === 'skipped'"
            size="small"
            text
            type="primary"
            @click="retryJob(job)"
          >
            重试
          </el-button>
          <el-button
            v-else-if="job.status === 'ready' && job.holdReason"
            size="small"
            text
            type="primary"
            @click="openJob(job)"
          >
            查看草稿
          </el-button>
          <el-button size="small" text @click="openJob(job)">查看</el-button>
        </div>
      </div>
      <p v-if="!store.convJobs.length" class="mc__empty">该会话没有未完成的回复任务</p>
    </div>
  </aside>
</template>

<style scoped>
.mc__right {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.mc__right-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--ht-line);
  font-size: 12.5px;
  font-weight: 600;
  color: var(--ht-text-1);
}

.mc__count {
  margin-left: auto;
  font-size: 12px;
  color: var(--ht-text-3);
}

.mc__jobs {
  flex: 1;
  overflow-y: auto;
  padding: 10px;
  display: flex;
  flex-direction: column;
  gap: 9px;
}

.spacer {
  flex: 1;
}

.jobcard {
  border: 1px solid var(--ht-line);
  border-radius: var(--ht-radius-sm);
  padding: 9px 10px;
  background: var(--ht-surface);
}

.jobcard__top {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}

.jobcard__status {
  font-size: 11.5px;
  font-weight: 600;
  color: var(--ht-text-2);
}

.jobcard__status.is-sent {
  color: var(--ht-ok);
}

.jobcard__status.is-failed {
  color: var(--ht-danger);
}

.jobcard__status.is-ready {
  color: var(--ht-warn);
}

.jobcard__status.is-skipped {
  color: var(--ht-text-3);
}

.jobcard__time {
  margin-left: auto;
  font-size: 11px;
  color: var(--ht-text-3);
  font-variant-numeric: tabular-nums;
}

.jobcard__summary {
  margin: 0 0 6px;
  font-size: 12px;
  color: var(--ht-text-2);
  line-height: 1.6;
  overflow-wrap: anywhere;
}

.jobcard__draft {
  margin: 0 0 8px;
  padding: 6px 8px;
  border-radius: 6px;
  background: var(--ht-primary-soft);
  color: var(--ht-text-1);
  font-size: 12px;
  line-height: 1.6;
  overflow-wrap: anywhere;
}

.jobcard__foot {
  display: flex;
  align-items: center;
  gap: 6px;
}

.mc__empty {
  padding: 22px 14px;
  text-align: center;
  font-size: 12px;
  color: var(--ht-text-3);
  line-height: 1.8;
}
</style>
