<script setup lang="ts">
/**
 * 消息中心左栏：监控会话列表（自 MessagesTab 拆出，quality-hardening-2026-10 4.1）。
 *
 * 纯展示 + 薄动作：选中/暂停/静音直接调 store（组合点例外），跨面板导航
 * （查看回复历史 / 管理监控）上抛给父级。
 */
import { computed, ref } from 'vue'
import { ElMessage } from 'element-plus'

import { IconSearch } from '@/components/icons'
import { useWelinkStore } from '@/stores/welink'
import type { WelinkConversation } from '@/types/welink'
import { muteLabel as muteLabelOf, shortStamp } from '@/utils/welink-display'

const emit = defineEmits<{
  (e: 'open-history', targetId: string): void
  /** 「管理监控」→ 父级切到监控配置 Tab */
  (e: 'manage'): void
}>()

const store = useWelinkStore()

const keyword = ref('')

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

/**
 * 静音剩余（O11：行置灰 + 「静音至 hh:mm」）—— 统一实现见 `utils/welink-display`。
 * 这里只保留「只显示时刻」的偏好（消息中心是日内视图，日期冗余）。
 */
const muteLabel = (conv: WelinkConversation): string => muteLabelOf(conv.muteUntil, new Date(), false)

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
  if (command === 'history') return emit('open-history', conv.convId)
  if (command.startsWith('mute:')) {
    const hours = Number(command.split(':')[1])
    return void store
      .muteConversation(conv.convId, hours)
      .then(() => ElMessage.success(`已静音 ${hours} 小时，到期自动恢复`))
  }
}

/** 时间列文案（统一实现，T-4） */
const timeLabel = (stamp: string) => shortStamp(stamp)
</script>

<template>
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
            <span v-if="conv.unreadCount" class="mc__badge" :title="`${conv.unreadCount} 条未读`">{{
              conv.unreadCount
            }}</span>
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
</template>

<style scoped>
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
</style>
