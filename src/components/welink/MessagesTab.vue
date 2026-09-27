<script setup lang="ts">
/**
 * Tab「消息中心」（设计 §11.1，要点 1/2）。
 *
 * 三栏：左 260px 监控会话列表 | 中自适应 会话时间线 | 右 320px 该会话待办回复（可折叠）。
 *
 * 关键行为：
 *  * 点会话 = 选中 + `markRead` 清未读（O6，单事务）；
 *  * 时间线倒序分页，向上滚「加载更早」（P7，每次 100 条）；
 *  * 左侧会话行显示未读角标 / @我 红点 / 最后消息时间 / 拉取健康度点 / 静音剩余；
 *  * 消息下方内联显示其回复状态微条，点击跳回复历史对应任务。
 */
import { computed, ref } from 'vue'
import { ElMessage } from 'element-plus'

import { IconSearch, IconUser } from '@/components/icons'
import { useWelinkStore } from '@/stores/welink'
import type { WelinkConversation, WelinkJob, WelinkMessage } from '@/types/welink'

const props = defineProps<{ focusConvId: string }>()
const emit = defineEmits<{
  (e: 'open-history', preset: { targetId?: string; onlyHolding?: boolean }): void
  /** 「管理监控」→ 父级切到监控配置 Tab（消息中心只管运行时，不承载配置编辑） */
  (e: 'manage'): void
}>()

const store = useWelinkStore()

const keyword = ref('')
const showRight = ref(true)

/** 外部（收件箱/跳转）指定的会话 → 自动选中 */
let lastFocus = ''
function applyFocus() {
  if (props.focusConvId && props.focusConvId !== lastFocus) {
    lastFocus = props.focusConvId
    void select(props.focusConvId)
  }
}
applyFocus()

const filtered = computed(() => {
  const kw = keyword.value.trim().toLowerCase()
  const list = store.watchingConversations
  if (!kw) return list
  return list.filter((item) => item.title.toLowerCase().includes(kw) || item.convId.toLowerCase().includes(kw))
})

const groupList = computed(() => filtered.value.filter((item) => item.convType === 'group'))
const privateList = computed(() => filtered.value.filter((item) => item.convType === 'private'))

async function select(convId: string) {
  try {
    await store.selectConversation(convId)
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '加载会话失败')
  }
}

/** 静音剩余（O11：行置灰 + 「静音至 hh:mm」） */
function muteLabel(conv: WelinkConversation): string {
  if (!conv.muteUntil) return ''
  return conv.muteUntil > nowStampText() ? `静音至 ${conv.muteUntil.slice(11, 16)}` : ''
}

function nowStampText(): string {
  const pad = (value: number) => String(value).padStart(2, '0')
  const date = new Date()
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  )
}

function convStateDot(convId: string): string {
  const state = store.convoStates[convId]
  if (!state) return 'is-idle'
  return state.state === 'backoff' ? 'is-warn' : 'is-ok'
}

function convStateTitle(convId: string): string {
  const state = store.convoStates[convId]
  if (!state) return '尚未拉取'
  if (state.state === 'backoff') return `拉取失败 ${state.failCount} 次，退避 ${state.backoffSec}s：${state.reason}`
  return state.lastOkAt ? `上次成功拉取：${state.lastOkAt}` : '拉取正常'
}

async function pauseMonitor(conv: WelinkConversation) {
  await store.updateConversation(conv.convId, { watching: false })
  ElMessage.success('该会话已暂停监控（消息不再拉取）')
}

/** 会话行操作菜单（§11.1 左栏「更多」） */
function onMenu(command: string, conv: WelinkConversation) {
  if (command === 'pause') return void pauseMonitor(conv)
  if (command === 'history') return emit('open-history', { targetId: conv.convId })
  if (command.startsWith('mute:')) {
    const hours = Number(command.split(':')[1])
    return void store.muteConversation(conv.convId, hours).then(() => ElMessage.success(`已静音 ${hours} 小时，到期自动恢复`))
  }
}

/** 消息 → 该消息触发的任务（用于内联状态微条） */
function jobOfMessage(message: WelinkMessage): WelinkJob | null {
  return store.convJobs.find((job) => job.triggerMsgPk === message.pk) ?? null
}

/**
 * 右栏行操作（§11.1）。
 * failed → 「重试」直接回 ready 入队（重发同样过 Gate）；
 * ready + hold_reason（manual 草稿/黑名单转审）→ 「查看草稿」跳回复历史并预设「待我处理」筛选。
 */
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

const timeLabel = (stamp: string) => stamp.slice(5, 16)
</script>

<template>
  <div class="mc" :class="{ 'mc--narrow': !showRight }">
    <!-- 左栏：监控会话列表 -->
    <aside class="mc__left">
      <div class="mc__search">
        <IconSearch class="mc__search-icon" />
        <input v-model="keyword" class="mc__input" placeholder="按群名 / 群号过滤" />
      </div>

      <div class="mc__list">
        <template v-if="groupList.length">
          <p class="section-label mc__group">群聊（{{ groupList.length }}）</p>
          <button
            v-for="conv in groupList"
            :key="conv.pk"
            class="mc__conv pressable"
            :class="{ 'is-active': store.selectedConvId === conv.convId, 'is-muted': muteLabel(conv) }"
            @click="select(conv.convId)"
          >
            <span class="mc__conv-main">
              <span class="mc__conv-title">{{ conv.title || conv.convId }}</span>
              <span class="mc__conv-meta">
                <span class="mc__state-dot" :class="convStateDot(conv.convId)" :title="convStateTitle(conv.convId)" />
                <span>{{ timeLabel(conv.lastMsgAt) || '暂无消息' }}</span>
                <span v-if="muteLabel(conv)" class="mc__muted">{{ muteLabel(conv) }}</span>
              </span>
            </span>
            <span class="mc__conv-badges">
              <span v-if="conv.mentionCount" class="mc__badge mc__badge--at" :title="`${conv.mentionCount} 条 @我`">
                @{{ conv.mentionCount }}
              </span>
              <span v-if="conv.unreadCount" class="mc__badge" :title="`${conv.unreadCount} 条未读`">{{ conv.unreadCount }}</span>
            </span>

            <!-- 行操作：暂停监控 / 静音 / 查看回复历史（§11.1） -->
            <el-dropdown trigger="click" class="mc__more" @command="(command: string) => onMenu(command, conv)">
              <span class="mc__more-btn" title="更多操作" @click.stop>⋯</span>
              <template #dropdown>
                <el-dropdown-menu>
                  <el-dropdown-item command="pause">暂停监控</el-dropdown-item>
                  <el-dropdown-item command="mute:1">静音 1 小时</el-dropdown-item>
                  <el-dropdown-item command="mute:8">静音 8 小时</el-dropdown-item>
                  <el-dropdown-item command="mute:24">静音到今天结束</el-dropdown-item>
                  <el-dropdown-item command="history" divided>查看回复历史</el-dropdown-item>
                </el-dropdown-menu>
              </template>
            </el-dropdown>
          </button>
        </template>

        <template v-if="privateList.length">
          <p class="section-label mc__group">私聊（{{ privateList.length }}）</p>
          <button
            v-for="conv in privateList"
            :key="conv.pk"
            class="mc__conv pressable"
            :class="{ 'is-active': store.selectedConvId === conv.convId, 'is-muted': muteLabel(conv) }"
            @click="select(conv.convId)"
          >
            <span class="mc__conv-main">
              <span class="mc__conv-title">{{ conv.title || conv.convId }}</span>
              <span class="mc__conv-meta">
                <span class="mc__state-dot" :class="convStateDot(conv.convId)" :title="convStateTitle(conv.convId)" />
                <span>{{ timeLabel(conv.lastMsgAt) || '暂无消息' }}</span>
                <span v-if="muteLabel(conv)" class="mc__muted">{{ muteLabel(conv) }}</span>
              </span>
            </span>
            <span class="mc__conv-badges">
              <span v-if="conv.unreadCount" class="mc__badge">{{ conv.unreadCount }}</span>
            </span>

            <el-dropdown trigger="click" class="mc__more" @command="(command: string) => onMenu(command, conv)">
              <span class="mc__more-btn" title="更多操作" @click.stop>⋯</span>
              <template #dropdown>
                <el-dropdown-menu>
                  <el-dropdown-item command="pause">暂停监控</el-dropdown-item>
                  <el-dropdown-item command="mute:1">静音 1 小时</el-dropdown-item>
                  <el-dropdown-item command="mute:8">静音 8 小时</el-dropdown-item>
                  <el-dropdown-item command="mute:24">静音到今天结束</el-dropdown-item>
                  <el-dropdown-item command="history" divided>查看回复历史</el-dropdown-item>
                </el-dropdown-menu>
              </template>
            </el-dropdown>
          </button>
        </template>

        <p v-if="!filtered.length" class="mc__empty">
          暂无监控会话。<br />
          <span class="mc__empty-hint">到「监控配置」同步或新增会话（新会话默认只存档不回复）。</span>
        </p>
      </div>

      <div class="mc__left-foot">
        <button class="link" @click="emit('manage')">管理监控 →</button>
      </div>
    </aside>

    <!-- 中栏：会话时间线 -->
    <section class="mc__mid">
      <header class="mc__mid-head">
        <span class="mc__mid-title">{{ store.selectedConversation?.title || '未选择会话' }}</span>
        <span v-if="store.selectedConversation" class="mc__mid-id mono">{{ store.selectedConversation.convId }}</span>
        <span class="spacer" />
        <el-button v-if="store.selectedConversation" size="small" text @click="showRight = !showRight">
          {{ showRight ? '收起待办' : '展开待办' }}
        </el-button>
      </header>

      <div v-if="!store.selectedConversation" class="mc__placeholder">
        <IconUser class="mc__placeholder-icon" />
        <p>从左侧选择一个会话查看存档消息</p>
      </div>

      <div v-else class="mc__stream">
        <button v-if="store.hasMoreMessages" class="mc__more pressable" @click="store.loadEarlierMessages()">加载更早的消息</button>
        <p v-else class="mc__stream-head">— 已到最早 —</p>

        <div
          v-for="message in store.messages"
          :key="message.msgUid"
          class="bubble"
          :class="message.direction === 'out' ? 'bubble--out' : 'bubble--in'"
        >
          <div class="bubble__head">
            <span v-if="message.atMe" class="bubble__at">@我</span>
            <span class="bubble__who">{{ message.direction === 'out' ? '我' : message.senderName || message.senderId }}</span>
            <span class="bubble__time">{{ timeLabel(message.sentAt) }}</span>
            <span v-if="message.msgType !== 'text'" class="bubble__type">[{{ message.msgType }}]</span>
          </div>
          <p class="bubble__text">{{ message.content }}</p>

          <!-- 内联回复状态微条（§11.1 中栏） -->
          <button
            v-if="jobOfMessage(message)"
            class="bubble__job pressable"
            :class="`is-${jobOfMessage(message)!.status}`"
            @click="$emit('open-history', { targetId: jobOfMessage(message)!.targetId })"
          >
            回复状态：{{ statusLabel(jobOfMessage(message)!) }}
            <span v-if="jobOfMessage(message)!.attempts" class="bubble__job-attempts">（重试 {{ jobOfMessage(message)!.attempts }} 次）</span>
            <span v-if="jobOfMessage(message)!.skipReason" class="bubble__job-skip">· {{ store.skipLabel(jobOfMessage(message)!.skipReason) }}</span>
          </button>
        </div>

        <p v-if="!store.messages.length" class="mc__empty">该会话暂无存档消息</p>
      </div>
    </section>

    <!-- 右栏：该会话待办回复 -->
    <aside v-if="showRight" class="mc__right">
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
            <el-tag v-if="job.holdReason" size="small" type="warning" effect="light">{{ store.holdLabel(job.holdReason) }}</el-tag>
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
            <el-button v-else-if="job.status === 'ready' && job.holdReason" size="small" text type="primary" @click="openJob(job)">
              查看草稿
            </el-button>
            <el-button size="small" text @click="openJob(job)">查看</el-button>
          </div>
        </div>
        <p v-if="!store.convJobs.length" class="mc__empty">该会话没有未完成的回复任务</p>
      </div>
    </aside>
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

.mc__left {
  display: flex;
  flex-direction: column;
  border-right: 1px solid var(--ht-line);
  min-width: 0;
}

.mc__search {
  position: relative;
  padding: 10px 10px 6px;
}

.mc__search-icon {
  position: absolute;
  left: 20px;
  top: 50%;
  transform: translateY(-40%);
  width: 14px;
  height: 14px;
  color: var(--ht-text-3);
  pointer-events: none;
}

.mc__input {
  width: 100%;
  height: 30px;
  padding: 0 10px 0 30px;
  border: 1px solid var(--ht-line);
  border-radius: var(--ht-radius-sm);
  background: var(--ht-surface);
  color: var(--ht-text-1);
  font: inherit;
  font-size: 12.5px;
}

.mc__input:focus {
  outline: none;
  border-color: var(--ht-primary);
}

.mc__list {
  flex: 1;
  overflow-y: auto;
  padding: 4px 8px 8px;
}

.mc__group {
  margin: 10px 0 4px;
  padding: 0 6px;
}

.mc__conv {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 7px 9px;
  border: none;
  border-radius: var(--ht-radius-sm);
  background: transparent;
  color: var(--ht-text-1);
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.mc__conv:hover {
  background: var(--ht-surface-2);
}

.mc__conv.is-active {
  background: var(--ht-primary-soft);
}

.mc__conv.is-muted {
  opacity: 0.55;
}

.mc__conv-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.mc__conv-title {
  font-size: 12.5px;
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.mc__conv-meta {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: var(--ht-text-3);
  font-variant-numeric: tabular-nums;
}

.mc__state-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex-shrink: 0;
  background: var(--ht-text-3);
}

.mc__state-dot.is-ok {
  background: var(--ht-ok);
}

.mc__state-dot.is-warn {
  background: var(--ht-warn);
}

.mc__muted {
  color: var(--ht-warn);
}

.mc__conv-badges {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 3px;
  flex-shrink: 0;
}

.mc__badge {
  min-width: 16px;
  height: 16px;
  padding: 0 5px;
  border-radius: 8px;
  background: var(--ht-text-3);
  color: #fff;
  font-size: 10.5px;
  line-height: 16px;
  text-align: center;
  font-variant-numeric: tabular-nums;
}

.mc__badge--at {
  background: var(--ht-danger);
}

.mc__more {
  flex-shrink: 0;
  opacity: 0;
  transition: opacity 0.15s ease;
}

.mc__conv:hover .mc__more,
.mc__more:focus-within {
  opacity: 1;
}

.mc__more-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  border-radius: 5px;
  color: var(--ht-text-3);
  font-size: 13px;
  line-height: 1;
  cursor: pointer;
}

.mc__more-btn:hover {
  background: var(--ht-surface-2);
  color: var(--ht-text-1);
}

.mc__left-foot {
  padding: 8px 10px;
  border-top: 1px solid var(--ht-line);
}

.link {
  border: none;
  background: transparent;
  color: var(--ht-primary);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
  padding: 0;
}

.mc__mid {
  display: flex;
  flex-direction: column;
  min-width: 0;
  border-right: 1px solid var(--ht-line);
}

.mc__mid-head,
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

.mc__more {
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

.mc__more:hover {
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

.mc__right {
  display: flex;
  flex-direction: column;
  min-width: 0;
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

.mc__empty-hint {
  font-size: 11.5px;
}

@media (max-width: 1180px) {
  .mc {
    grid-template-columns: 220px minmax(0, 1fr);
  }

  .mc__right {
    display: none;
  }
}
</style>