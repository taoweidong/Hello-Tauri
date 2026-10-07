<script setup lang="ts">
/**
 * Tab「消息中心」（设计 §11.1，要点 1/2）。
 *
 * 三栏：左 260px 监控会话列表 | 中自适应 会话时间线 | 右 320px 该会话待办回复（可折叠）。
 * 三栏各自成子组件（messages/ 目录，quality-hardening-2026-10 4.1）：
 * 会话/时间线/待办的交互各自直达 store，本父级只持有跨面板的编排 ——
 * 外部跳转的自动选中（focusConvId）、右栏折叠、导航事件转发。
 */
import { ref } from 'vue'
import { ElMessage } from 'element-plus'

import { useWelinkStore } from '@/stores/welink'
import ConversationListPanel from './messages/ConversationListPanel.vue'
import TimelinePanel from './messages/TimelinePanel.vue'
import PendingJobsPanel from './messages/PendingJobsPanel.vue'

const props = defineProps<{ focusConvId: string }>()
const emit = defineEmits<{
  (e: 'open-history', preset: { targetId?: string; onlyHolding?: boolean }): void
  /** 「管理监控」→ 父级切到监控配置 Tab（消息中心只管运行时，不承载配置编辑） */
  (e: 'manage'): void
}>()

const store = useWelinkStore()

const showRight = ref(true)

/** 外部（收件箱/跳转）指定的会话 → 自动选中 */
let lastFocus = ''
function applyFocus() {
  if (props.focusConvId && props.focusConvId !== lastFocus) {
    lastFocus = props.focusConvId
    void store.selectConversation(props.focusConvId).catch((error: unknown) => {
      ElMessage.error(error instanceof Error ? error.message : '加载会话失败')
    })
  }
}
applyFocus()
</script>

<template>
  <div class="mc" :class="{ 'mc--narrow': !showRight }">
    <ConversationListPanel
      @open-history="(targetId: string) => emit('open-history', { targetId })"
      @manage="emit('manage')"
    />

    <TimelinePanel
      :show-right="showRight"
      @open-history="(targetId: string) => emit('open-history', { targetId })"
      @toggle-right="showRight = !showRight"
    />

    <PendingJobsPanel v-if="showRight" @open-history="(preset) => emit('open-history', preset)" />
  </div>
</template>

<style scoped>
.mc {
  display: grid;
  grid-template-columns: 260px minmax(0, 1fr) 320px;
  min-height: 420px;
}

.mc--narrow {
  grid-template-columns: 260px minmax(0, 1fr);
}

@media (max-width: 1180px) {
  .mc {
    grid-template-columns: 220px minmax(0, 1fr);
  }

  .mc :deep(.mc__right) {
    display: none;
  }
}
</style>
