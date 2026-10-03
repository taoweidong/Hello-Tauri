<script setup lang="ts">
/**
 * 消息中心中栏：会话时间线（自 MessagesTab 拆出，quality-hardening-2026-10 4.1）。
 *
 * 倒序分页向上加载（P7）；消息下方内联回复状态微条，点击跳回复历史。
 * 待办栏折叠开关由父级持有（决定三栏/两栏网格），本组件只上报切换意图。
 */
import { IconUser } from '@/components/icons'
import { useWelinkStore } from '@/stores/welink'
import type { WelinkJob, WelinkMessage } from '@/types/welink'
import { shortStamp } from '@/utils/welink-display'

defineProps<{ showRight: boolean }>()
const emit = defineEmits<{
  (e: 'open-history', targetId: string): void
  (e: 'toggle-right'): void
}>()

const store = useWelinkStore()

/** 消息 → 该消息触发的任务（用于内联状态微条） */
function jobOfMessage(message: WelinkMessage): WelinkJob | null {
  return store.convJobs.find((job) => job.triggerMsgPk === message.pk) ?? null
}

const statusLabel = (job: WelinkJob) => store.statusLabel(job.status)

/** 时间列文案（统一实现，T-4） */
const timeLabel = (stamp: string) => shortStamp(stamp)
</script>

<template>
  <section class="mc__mid">
    <header class="mc__mid-head">
      <span class="mc__mid-title">{{ store.selectedConversation?.title || '未选择会话' }}</span>
      <span v-if="store.selectedConversation" class="mc__mid-id mono">{{ store.selectedConversation.convId }}</span>
      <span class="spacer" />
      <el-button v-if="store.selectedConversation" size="small" text @click="emit('toggle-right')">
        {{ showRight ? '收起待办' : '展开待办' }}
      </el-button>
    </header>

    <div v-if="!store.selectedConversation" class="mc__placeholder">
      <IconUser class="mc__placeholder-icon" />
      <p>从左侧选择一个会话查看存档消息</p>
    </div>

    <div v-else class="mc__stream">
      <button v-if="store.hasMoreMessages" class="mc__load-earlier pressable" @click="store.loadEarlierMessages()">
        加载更早的消息
      </button>
      <p v-else class="mc__stream-head">— 已到最早 —</p>

      <div
        v-for="message in store.messages"
        :key="message.msgUid"
        class="bubble"
        :class="message.direction === 'out' ? 'bubble--out' : 'bubble--in'"
      >
        <div class="bubble__head">
          <span v-if="message.atMe" class="bubble__at">@我</span>
          <span class="bubble__who">{{
            message.direction === 'out' ? '我' : message.senderName || message.senderId
          }}</span>
          <span class="bubble__time">{{ timeLabel(message.sentAt) }}</span>
          <span v-if="message.msgType !== 'text'" class="bubble__type">[{{ message.msgType }}]</span>
        </div>
        <p class="bubble__text">{{ message.content }}</p>

        <!-- 内联回复状态微条（§11.1 中栏） -->
        <button
          v-if="jobOfMessage(message)"
          class="bubble__job pressable"
          :class="`is-${jobOfMessage(message)!.status}`"
          @click="emit('open-history', jobOfMessage(message)!.targetId)"
        >
          回复状态：{{ statusLabel(jobOfMessage(message)!) }}
          <span v-if="jobOfMessage(message)!.attempts" class="bubble__job-attempts"
            >（重试 {{ jobOfMessage(message)!.attempts }} 次）</span
          >
          <span v-if="jobOfMessage(message)!.skipReason" class="bubble__job-skip"
            >· {{ store.skipLabel(jobOfMessage(message)!.skipReason) }}</span
          >
        </button>
      </div>

      <p v-if="!store.messages.length" class="mc__empty">该会话暂无存档消息</p>
    </div>
  </section>
</template>

<style scoped>
.mc__mid {
  display: flex;
  flex-direction: column;
  min-width: 0;
  border-right: 1px solid var(--ht-line);
}

.mc__mid-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--ht-line);
  font-size: 12.5px;
  font-weight: 600;
  color: var(--ht-text-1);
}

.mc__mid-id {
  font-size: 11px;
  color: var(--ht-text-3);
}

.spacer {
  flex: 1;
}

.mc__placeholder {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  color: var(--ht-text-3);
  font-size: 12.5px;
}

.mc__placeholder-icon {
  width: 28px;
  height: 28px;
  opacity: 0.5;
}

.mc__stream {
  flex: 1;
  overflow-y: auto;
  padding: 12px 14px 16px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

/* 原 .mc__more 与左栏菜单类名冲突，拆分时更名消除歧义 */
.mc__load-earlier {
  align-self: center;
  padding: 5px 14px;
  border: 1px solid var(--ht-line);
  border-radius: 14px;
  background: var(--ht-surface);
  color: var(--ht-text-2);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}

.mc__load-earlier:hover {
  border-color: var(--ht-primary-line);
  color: var(--ht-primary);
}

.mc__stream-head {
  margin: 0;
  text-align: center;
  font-size: 11px;
  color: var(--ht-text-3);
}

.bubble {
  max-width: 78%;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.bubble--in {
  align-self: flex-start;
}

.bubble--out {
  align-self: flex-end;
}

.bubble__head {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: var(--ht-text-3);
  font-variant-numeric: tabular-nums;
}

.bubble--out .bubble__head {
  flex-direction: row-reverse;
}

.bubble__at {
  padding: 0 5px;
  border-radius: 4px;
  background: var(--el-color-danger-light-9);
  color: var(--ht-danger);
  font-weight: 600;
}

.bubble__who {
  font-weight: 600;
  color: var(--ht-text-2);
}

.bubble__type {
  color: var(--ht-text-3);
}

.bubble__text {
  margin: 0;
  padding: 8px 11px;
  border-radius: 9px;
  font-size: 13px;
  line-height: 1.65;
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}

.bubble--in .bubble__text {
  background: var(--ht-surface-2);
  color: var(--ht-text-1);
  border-top-left-radius: 3px;
}

.bubble--out .bubble__text {
  background: var(--ht-primary);
  color: #fff;
  border-top-right-radius: 3px;
}

.bubble__job {
  align-self: flex-start;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 3px 9px;
  border: 1px dashed var(--ht-line-strong);
  border-radius: 6px;
  background: transparent;
  color: var(--ht-text-3);
  font: inherit;
  font-size: 11px;
  cursor: pointer;
}

.bubble__job:hover {
  border-color: var(--ht-primary-line);
  color: var(--ht-primary);
}

.bubble__job.is-sent {
  border-color: var(--ht-ok);
  color: var(--ht-ok);
}

.bubble__job.is-failed {
  border-color: var(--ht-danger);
  color: var(--ht-danger);
}

.bubble__job.is-ready {
  border-color: var(--ht-warn);
  color: var(--ht-warn);
}

.bubble__job-attempts,
.bubble__job-skip {
  color: inherit;
  opacity: 0.8;
}

.mc__empty {
  padding: 22px 14px;
  text-align: center;
  font-size: 12px;
  color: var(--ht-text-3);
  line-height: 1.8;
}
</style>
