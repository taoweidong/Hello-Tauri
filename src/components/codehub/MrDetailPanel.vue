<script setup lang="ts">
/**
 * MR 详情面板（personal-workbench）—— 检视页右侧的只读详情视图。
 *
 * 数据一律来自本地快照（spec「检视页筛选与详情」）：`detail` 为 null 表示快照里
 * 只有列表字段（同步输出截断/精简），面板显示「详情待补拉」占位；补拉由父级经
 * 编排层触发（loading 态），结果回写快照后再进入本面板 —— 面板自身不发任何调用。
 */
import { IconAlert, IconClock, IconGitBranch, IconUser, IconX } from '@/components/icons'
import MrStateBadge from '@/components/codehub/MrStateBadge.vue'
import type { CodeHubMrRecord } from '@/types/codehub'

defineProps<{
  record: CodeHubMrRecord | null
  /** 详情补拉进行中（detail 为 null 时父级会触发单条补拉） */
  loading?: boolean
}>()

const emit = defineEmits<{ (e: 'close'): void }>()
</script>

<template>
  <section v-if="record" class="detail" aria-label="MR 详情">
    <header class="detail__head">
      <MrStateBadge :state="record.summary.state" />
      <h2 class="detail__title">{{ record.summary.title }}</h2>
      <button class="detail__close" aria-label="关闭详情" @click="emit('close')"><IconX class="detail__mini" /></button>
    </header>

    <p v-if="!record.detail" class="detail__missing">
      <IconAlert class="detail__mini" />
      {{ loading ? '详情补拉中…' : '快照中无详情载荷：再次点开可重试补拉' }}
    </p>
    <p v-else class="detail__desc">{{ record.detail.description || '（无描述）' }}</p>

    <dl class="detail__kv">
      <dt>仓库</dt>
      <dd class="mono">{{ record.summary.repoId }}</dd>
      <dt>MR</dt>
      <dd class="mono">!{{ record.summary.mrIid }}</dd>
      <dt>作者</dt>
      <dd><IconUser class="detail__mini" />{{ record.summary.author || '-' }}</dd>
      <dt>分支</dt>
      <dd>
        <IconGitBranch class="detail__mini" />{{ record.summary.sourceBranch || '?' }} →
        {{ record.summary.targetBranch || '?' }}
      </dd>
      <dt>更新于</dt>
      <dd><IconClock class="detail__mini" />{{ record.summary.updatedAt || '-' }}</dd>
      <dt>检视</dt>
      <dd>
        {{ record.summary.review.approvals }} 赞成 · {{ record.summary.review.unresolved }} 未解决
        <span v-if="record.summary.review.reviewers.length" class="detail__reviewers">
          （{{ record.summary.review.reviewers.join('、') }}）
        </span>
      </dd>
    </dl>

    <template v-if="record.detail && record.detail.comments.length">
      <h3 class="detail__sub">检视意见（{{ record.detail.comments.length }}）</h3>
      <ul class="detail__comments">
        <li v-for="(comment, index) in record.detail.comments" :key="index" class="detail__comment">
          <span class="detail__comment-author">{{ comment.author || '匿名' }}</span>
          <span class="detail__comment-body">{{ comment.body }}</span>
          <span class="detail__comment-time">{{ comment.createdAt }}</span>
        </li>
      </ul>
    </template>
    <p v-else-if="record.detail" class="detail__nocomment">暂无检视意见</p>
  </section>
</template>

<style scoped>
.detail {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 16px;
}

.detail__head {
  display: flex;
  align-items: baseline;
  gap: 10px;
  min-width: 0;
}

.detail__title {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
  color: var(--ht-text-1);
  overflow-wrap: anywhere;
}

.detail__close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  margin-left: auto;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--ht-text-3);
  cursor: pointer;
  flex-shrink: 0;
}

.detail__close:hover {
  color: var(--ht-text-1);
  background: var(--ht-surface-2);
}

.detail__desc {
  margin: 0;
  font-size: 13px;
  line-height: 1.7;
  color: var(--ht-text-2);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.detail__missing {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0;
  padding: 8px 10px;
  border: 1px dashed var(--ht-line-strong);
  border-radius: 8px;
  font-size: 12px;
  color: var(--ht-text-3);
}

.detail__kv {
  display: grid;
  grid-template-columns: auto 1fr;
  margin: 0;
  border-top: 1px solid var(--ht-line);
}

.detail__kv dt {
  padding: 7px 14px 7px 0;
  font-size: 12px;
  color: var(--ht-text-3);
  white-space: nowrap;
}

.detail__kv dd {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 7px 0;
  margin: 0;
  font-size: 12.5px;
  color: var(--ht-text-1);
  overflow-wrap: anywhere;
}

.detail__kv > dt:not(:first-of-type),
.detail__kv > dd:not(:first-of-type) {
  border-top: 1px solid var(--ht-line);
}

.detail__mini {
  width: 13px;
  height: 13px;
  color: var(--ht-text-3);
  flex-shrink: 0;
}

.detail__reviewers {
  color: var(--ht-text-3);
  font-size: 12px;
}

.detail__sub {
  margin: 0;
  font-size: 12.5px;
  font-weight: 600;
  color: var(--ht-text-2);
}

.detail__comments {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.detail__comment {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 8px 10px;
  border: 1px solid var(--ht-line);
  border-radius: 8px;
  background: var(--ht-surface-2);
}

.detail__comment-author {
  font-size: 12px;
  font-weight: 600;
  color: var(--ht-text-2);
}

.detail__comment-body {
  font-size: 12.5px;
  line-height: 1.6;
  color: var(--ht-text-1);
  overflow-wrap: anywhere;
}

.detail__comment-time {
  font-size: 11px;
  color: var(--ht-text-3);
}

.detail__nocomment {
  margin: 0;
  font-size: 12px;
  color: var(--ht-text-3);
}
</style>
