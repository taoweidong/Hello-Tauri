<script setup lang="ts">
/**
 * Tab「私聊收件箱」（设计 §11.2，R2）。
 *
 * 左：有过私聊 in 消息的联系人（昵称+工号、未读数、最后消息时间，按最后消息倒序）
 * 右：该联系人完整私聊时间线（in/out 双色，分页）
 *
 * 筛选器：时间段（默认最近 30 天）/ 只看未回复 / 关键词搜索（O12，LIKE + 分页）。
 * 这一页的价值是「私聊双向存档」的可查性 —— 自动回复只是其中一种动作。
 */
import { computed, onMounted, reactive, ref } from 'vue'
import { ElMessage } from 'element-plus'

import { IconSearch } from '@/components/icons'
import { useWelinkStore } from '@/stores/welink'
import type { WelinkMessage } from '@/types/welink'

const emit = defineEmits<{ (e: 'open-conversation', convId: string): void }>()
const store = useWelinkStore()

const filter = reactive({ keyword: '', from: daysAgo(30), to: '', onlyUnreplied: false })
const threads = ref<Array<{ convPk: number; convId: string; title: string; unreadCount: number; lastMsgAt: string; lastContent: string }>>([])
const loading = ref(false)
const selectedConvId = ref('')
const detail = ref<WelinkMessage[]>([])
const detailLimit = ref(100)

/**
 * O12 消息内容搜索：`searchMessages`（LIKE + 分页）走的是消息正文，
 * 与上面的「按昵称/工号过滤联系人」是两条独立路径 ——
 * 前者回答「谁提到过这句话」，后者回答「这个人是谁」。面板同理分两种呈现。
 */
const msgSearch = reactive({ active: false, loading: false, rows: [] as WelinkMessage[], offset: 0, done: false })

const selectedThread = computed(() => threads.value.find((item) => item.convId === selectedConvId.value) ?? null)

/** 结果行归属的会话标题（搜索结果是跨会话的平铺序列） */
function convTitleOf(convPk: number): string {
  const conv = store.conversations.find((item) => item.pk === convPk)
  if (!conv) return `#${convPk}`
  return conv.title || conv.convId
}

function daysAgo(days: number): string {
  const date = new Date(Date.now() - days * 24 * 3600 * 1000)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} 00:00:00`
}

async function load() {
  loading.value = true
  try {
    threads.value = await store.listInbox({
      keyword: filter.keyword || undefined,
      from: filter.from || undefined,
      to: filter.to ? `${filter.to} 23:59:59` : undefined,
      onlyUnreplied: filter.onlyUnreplied || undefined,
      limit: 100,
      offset: 0,
    })
    if (threads.value.length && !threads.value.some((item) => item.convId === selectedConvId.value)) {
      await selectThread(threads.value[0].convId)
    }
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '加载收件箱失败')
  } finally {
    loading.value = false
  }
}

async function selectThread(convId: string) {
  selectedConvId.value = convId
  const conv = store.conversations.find((item) => item.convId === convId)
  if (!conv) return
  // 打开即清未读（与消息中心同一套口径，O6）
  await store.selectConversation(convId, detailLimit.value)
  detail.value = store.messages
}

async function loadEarlier() {
  detailLimit.value += 100
  await store.selectConversation(selectedConvId.value, detailLimit.value)
  detail.value = store.messages
}

function resetFilters() {
  filter.keyword = ''
  filter.from = daysAgo(30)
  filter.to = ''
  filter.onlyUnreplied = false
  msgSearch.active = false
  msgSearch.rows = []
  msgSearch.offset = 0
  msgSearch.done = false
  void load()
}

/**
 * 搜索消息正文（O12）。分页由 offset 累加驱动；结果按 sent_at DESC 平铺，
 * 不按会话聚合 —— 目的是「定位那句话」，命中后点行即跳到对应会话时间线。
 */
async function searchContent(reset = true) {
  const kw = filter.keyword.trim()
  if (!kw) {
    ElMessage.warning('请输入关键词')
    return
  }
  if (reset) {
    msgSearch.rows = []
    msgSearch.offset = 0
    msgSearch.done = false
  }
  msgSearch.active = true
  msgSearch.loading = true
  try {
    const rows = await store.searchMessages(
      kw,
      filter.from || undefined,
      filter.to ? `${filter.to} 23:59:59` : undefined,
      50,
      msgSearch.offset,
    )
    msgSearch.rows = [...msgSearch.rows, ...rows]
    msgSearch.offset += rows.length
    msgSearch.done = rows.length < 50
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '搜索消息失败')
  } finally {
    msgSearch.loading = false
  }
}

/** 命中结果 → 跳到所属会话时间线（并清空搜索态，回到常规浏览） */
async function openHit(message: WelinkMessage) {
  const conv = store.conversations.find((item) => item.pk === message.convPk)
  if (!conv) {
    ElMessage.warning('该消息所属会话已不在配置中')
    return
  }
  msgSearch.active = false
  await load()
  await selectThread(conv.convId)
}

const timeLabel = (stamp: string) => stamp.slice(5, 16)

onMounted(load)
</script>

<template>
  <div class="inbox">
    <!-- 筛选器 -->
    <div class="inbox__filter">
      <div class="inbox__search">
        <IconSearch class="inbox__search-icon" />
        <input v-model="filter.keyword" class="inbox__input" placeholder="按昵称 / 工号搜索" @keyup.enter="load()" />
      </div>
      <el-date-picker v-model="filter.from" type="date" size="small" placeholder="开始日期" value-format="YYYY-MM-DD" class="inbox__date" />
      <span class="inbox__tilde">→</span>
      <el-date-picker v-model="filter.to" type="date" size="small" placeholder="结束日期" value-format="YYYY-MM-DD" class="inbox__date" />
      <el-checkbox v-model="filter.onlyUnreplied" size="small">只看未回复</el-checkbox>
      <el-button size="small" type="primary" plain @click="load()">筛选联系人</el-button>
      <!-- O12：切到「搜消息正文」模式，结果跨会话平铺 -->
      <el-button size="small" type="primary" :plain="!msgSearch.active" @click="searchContent(true)">搜正文</el-button>
      <el-button size="small" text @click="resetFilters">重置</el-button>
    </div>

    <!-- O12 搜索结果面板：定位「谁提到过这句话」，点行跳到该会话时间线 -->
    <div v-if="msgSearch.active" class="inbox__hits" v-loading="msgSearch.loading">
      <header class="inbox__hits-head">
        <span>正文命中 <b class="num">{{ msgSearch.rows.length }}</b> 条</span>
        <span class="spacer" />
        <el-button size="small" text @click="msgSearch.active = false">返回联系人</el-button>
      </header>
      <div
        v-for="hit in msgSearch.rows"
        :key="hit.msgUid"
        class="hit pressable"
        @click="openHit(hit)"
      >
        <span class="hit__conv">{{ convTitleOf(hit.convPk) }}</span>
        <span class="hit__who">{{ hit.direction === 'out' ? '我' : hit.senderName || hit.senderId }}</span>
        <span class="hit__text">{{ hit.content }}</span>
        <span class="hit__time">{{ timeLabel(hit.sentAt) }}</span>
      </div>
      <p v-if="!msgSearch.rows.length && !msgSearch.loading" class="inbox__empty">没有命中的消息</p>
      <div v-if="msgSearch.rows.length && !msgSearch.done" class="inbox__hits-more">
        <el-button size="small" text @click="searchContent(false)">加载更多</el-button>
      </div>
    </div>

    <div v-else class="inbox__body">
      <!-- 左：联系人列表 -->
      <aside class="inbox__list" v-loading="loading">
        <button
          v-for="thread in threads"
          :key="thread.convId"
          class="thread pressable"
          :class="{ 'is-active': thread.convId === selectedConvId }"
          @click="selectThread(thread.convId)"
        >
          <span class="thread__main">
            <span class="thread__title">{{ thread.title }}</span>
            <span class="thread__preview">{{ thread.lastContent || '（无内容）' }}</span>
          </span>
          <span class="thread__side">
            <span class="thread__time">{{ timeLabel(thread.lastMsgAt) }}</span>
            <span v-if="thread.unreadCount" class="thread__badge">{{ thread.unreadCount }}</span>
          </span>
        </button>
        <p v-if="!threads.length && !loading" class="inbox__empty">最近 30 天没有私聊记录</p>
      </aside>

      <!-- 右：明细时间线 -->
      <section class="inbox__detail">
        <header class="inbox__detail-head">
          <template v-if="selectedThread">
            <span class="inbox__detail-title">{{ selectedThread.title }}</span>
            <span class="mono inbox__detail-id">{{ selectedThread.convId }}</span>
            <span class="inbox__detail-hint">来自该联系人的全部私聊（含已回复）</span>
          </template>
          <span v-else class="inbox__detail-hint">请选择左侧联系人</span>
          <span class="spacer" />
          <el-button v-if="selectedThread" size="small" text @click="emit('open-conversation', selectedThread.convId)">
            回到此会话
          </el-button>
        </header>

        <div v-if="selectedThread" class="inbox__stream">
          <button class="inbox__more pressable" @click="loadEarlier">加载更早</button>
          <div
            v-for="message in detail"
            :key="message.msgUid"
            class="bubble"
            :class="message.direction === 'out' ? 'bubble--out' : 'bubble--in'"
          >
            <div class="bubble__head">
              <span class="bubble__who">{{ message.direction === 'out' ? '我' : message.senderName || message.senderId }}</span>
              <span class="bubble__time">{{ timeLabel(message.sentAt) }}</span>
            </div>
            <p class="bubble__text">{{ message.content }}</p>
          </div>
          <p v-if="!detail.length" class="inbox__empty">该联系人暂无存档消息</p>
        </div>
        <p v-else class="inbox__empty">选择左侧联系人查看完整私聊时间线</p>
      </section>
    </div>

    <p class="inbox__note">
      私聊双向存档（收/发都落库）；自动回复开关在「监控配置」与设置页。未读状态与消息中心共用同一口径。
    </p>
  </div>
</template>

<style scoped>
.inbox {
  display: flex;
  flex-direction: column;
  min-height: 420px;
}

.inbox__filter {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--ht-line);
  flex-wrap: wrap;
}

.inbox__search {
  position: relative;
  width: 200px;
}

/* ---- O12 正文搜索结果 ---- */
.inbox__hits {
  flex: 1;
  min-height: 360px;
  padding: 8px 14px;
  overflow: auto;
}

.inbox__hits-head {
  display: flex;
  align-items: center;
  padding: 6px 0 10px;
  font-size: 12px;
  color: var(--ht-text-2);
}

.inbox__hits-more {
  display: flex;
  justify-content: center;
  padding: 8px 0;
}

.hit {
  display: grid;
  grid-template-columns: 150px 80px minmax(0, 1fr) 90px;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 8px 10px;
  border: 1px solid var(--ht-line);
  border-radius: 6px;
  background: var(--ht-surface);
  text-align: left;
  margin-bottom: 6px;
  cursor: pointer;
}

.hit__conv {
  font-size: 12px;
  color: var(--ht-text-2);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.hit__who {
  font-size: 12px;
  color: var(--ht-text-3);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.hit__text {
  font-size: 13px;
  color: var(--ht-text-1);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.hit__time {
  font-size: 12px;
  color: var(--ht-text-3);
  text-align: right;
}

.inbox__search-icon {
  position: absolute;
  left: 9px;
  top: 50%;
  transform: translateY(-50%);
  width: 13px;
  height: 13px;
  color: var(--ht-text-3);
  pointer-events: none;
}

.inbox__input {
  width: 100%;
  height: 28px;
  padding: 0 9px 0 27px;
  border: 1px solid var(--ht-line);
  border-radius: var(--ht-radius-sm);
  background: var(--ht-surface);
  color: var(--ht-text-1);
  font: inherit;
  font-size: 12.5px;
}

.inbox__input:focus {
  outline: none;
  border-color: var(--ht-primary);
}

.inbox__date {
  width: 140px;
}

.inbox__tilde {
  color: var(--ht-text-3);
  font-size: 12px;
}

.inbox__body {
  display: grid;
  grid-template-columns: 280px minmax(0, 1fr);
  flex: 1;
  min-height: 0;
}

.inbox__list {
  border-right: 1px solid var(--ht-line);
  overflow-y: auto;
  padding: 8px;
}

.thread {
  display: flex;
  align-items: center;
  gap: 8px;
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

.thread:hover {
  background: var(--ht-surface-2);
}

.thread.is-active {
  background: var(--ht-primary-soft);
}

.thread__main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.thread__title {
  font-size: 12.5px;
  font-weight: 500;
}

.thread__preview {
  font-size: 11.5px;
  color: var(--ht-text-3);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.thread__side {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 4px;
  flex-shrink: 0;
}

.thread__time {
  font-size: 11px;
  color: var(--ht-text-3);
  font-variant-numeric: tabular-nums;
}

.thread__badge {
  min-width: 16px;
  height: 16px;
  padding: 0 5px;
  border-radius: 8px;
  background: var(--ht-danger);
  color: #fff;
  font-size: 10.5px;
  line-height: 16px;
  text-align: center;
}

.inbox__detail {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.inbox__detail-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--ht-line);
}

.inbox__detail-title {
  font-size: 12.5px;
  font-weight: 600;
  color: var(--ht-text-1);
}

.inbox__detail-id {
  font-size: 11px;
}

.inbox__detail-hint {
  font-size: 11.5px;
  color: var(--ht-text-3);
}

.spacer {
  flex: 1;
}

.inbox__stream {
  flex: 1;
  overflow-y: auto;
  padding: 12px 14px 16px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.inbox__more {
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

.inbox__more:hover {
  border-color: var(--ht-primary-line);
  color: var(--ht-primary);
}

.bubble {
  max-width: 76%;
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

.bubble__who {
  font-weight: 600;
  color: var(--ht-text-2);
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

.inbox__empty {
  padding: 24px 14px;
  text-align: center;
  font-size: 12px;
  color: var(--ht-text-3);
}

.inbox__note {
  margin: 0;
  padding: 9px 14px;
  border-top: 1px solid var(--ht-line);
  font-size: 11.5px;
  color: var(--ht-text-3);
}
</style>