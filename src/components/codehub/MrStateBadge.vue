<script setup lang="ts">
/**
 * MR 状态徽标（personal-workbench）—— 列表行与详情面板共用的一枚小标签。
 *
 * 独立成组件不是为了「复用方便」，而是因为状态文案 + 配色此前在检视页写了三份
 * （视图的 `stateLabel()` 三元、列表徽标 class、面板的 `STATE_LABEL` 映射），
 * 三份真值迟早漂移。现在文案唯一真值在 `CODEHUB_STATE_LABEL`，样式只有这里。
 *
 * class 名刻意避开全局 `.pill`（`styles/index.css` 里那款带状态圆点，语义不同）。
 */
import type { CodeHubMrState } from '@/types/codehub'
import { CODEHUB_STATE_LABEL } from '@/types/codehub'

defineProps<{ state: CodeHubMrState }>()
</script>

<template>
  <span class="mr-state" :class="`mr-state--${state}`">{{ CODEHUB_STATE_LABEL[state] }}</span>
</template>

<style scoped>
.mr-state {
  flex-shrink: 0;
  padding: 2px 8px;
  border-radius: 999px;
  font-size: 11px;
  white-space: nowrap;
  background: var(--ht-surface-2);
  color: var(--ht-text-3);
}

.mr-state--open {
  background: var(--ht-primary-soft);
  color: var(--ht-primary-strong);
}

.mr-state--merged {
  background: rgba(34, 160, 93, 0.12);
  color: #1d7c48;
}

/* closed 用基类的中性配色，不再单独写一条 —— 三态里只有它无强调 */
</style>
