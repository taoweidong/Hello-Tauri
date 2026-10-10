<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { IconActivity, IconUsers, IconGitBranch, IconRefresh, IconArrowRight, IconCheck } from '@/components/icons'

import { platform } from '@/api'
import type { CodeHubMrRecord } from '@/types/codehub'
import type { WelinkJob } from '@/types/welink'
import { useAppStore } from '@/stores/app'
import { useWelinkStore } from '@/stores/welink'
import { useCodehubStore } from '@/stores/codehub'
import { useGroupStore } from '@/stores/group'
import { useUpdateStore } from '@/stores/update'
import { logger } from '@/utils/logger'
import { shortStamp } from '@/utils/welink-display'

const router = useRouter()
const appStore = useAppStore()
const welinkStore = useWelinkStore()
const codehubStore = useCodehubStore()
const groupStore = useGroupStore()
/** 自动更新（design-auto-update）：工作台只提示不操作（小红点），安装入口在配置页 */
const updateStore = useUpdateStore()

function fmt(n: number) {
  return n.toLocaleString('zh-CN')
}

const platformLabel = computed(() => (platform === 'tauri' ? '桌面' : 'Web'))

// ---------------- 摘要装载（全部只读：查本地快照/库，不触发同步与轮询） ----------------

/** 队列预览条数：工作台只做摘要，全量清单在各域页面处理 */
const PREVIEW_LIMIT = 4

const codehubReady = ref(false)
const openMrCount = ref(0)
const openMrs = ref<CodeHubMrRecord[]>([])

const welinkReady = ref(false)
const reviewQueue = ref<WelinkJob[]>([])

const groupCount = ref(0)

async function loadReviewQueue() {
  try {
    reviewQueue.value = await welinkStore.listJobs({ onlyHolding: true, limit: PREVIEW_LIMIT, offset: 0 })
  } catch (error) {
    logger.warn('工作台装载待审预览失败', error)
  }
}

onMounted(async () => {
  // CodeHub 摘要：迁移 + 装载（应用级装配幂等，App.vue 启动也会触发）；只读快照计数与列表
  try {
    if (await codehubStore.init()) {
      const [count, records] = await Promise.all([
        codehubStore.countMrs({ state: 'open' }),
        codehubStore.listMrs({ state: 'open', limit: PREVIEW_LIMIT, offset: 0 }),
      ])
      openMrCount.value = count
      openMrs.value = records
      codehubReady.value = true
    }
  } catch (error) {
    logger.warn('工作台装载 CodeHub 摘要失败', error)
  }

  // WeLink 摘要：只读装载（不 start —— 轮询恢复只在助手页进行），待审/未读数字才可信
  try {
    const { panicRecovered } = await welinkStore.init(appStore.settings.weLink)
    welinkReady.value = true
    await loadReviewQueue()
    if (panicRecovered) {
      // 急停跨重启不复活（评审 P1）：与 WeLinkView 同款处置 —— 降级写回持久层并显式告知
      appStore.settings.weLink = { ...welinkStore.settings, sendMode: 'manual', panicked: false }
      ElMessage.error('上次会话以「一键全停」结束：已降为人工确认模式，未自动恢复外发')
    }
  } catch (error) {
    logger.warn('工作台装载 WeLink 摘要失败', error)
  }

  // 快速建群摘要：模板 + 历史计数（init 幂等，含启动清扫）
  try {
    if (await groupStore.init()) {
      groupCount.value = await groupStore.countJobs({})
    }
  } catch (error) {
    logger.warn('工作台装载建群摘要失败', error)
  }
})

// 待审数量变化（轮询/页面操作）→ 队列预览跟随刷新
watch(
  () => welinkStore.reviewCount,
  () => {
    if (welinkReady.value) void loadReviewQueue()
  },
)

// ---------------- 双域状态面板（首页聚焦 WeLink 与 CodeHub 两个业务域） ----------------

/** 状态灯语义色：ok 绿 / warn 橙 / danger 红 / idle 中性灰 */
type Tone = 'ok' | 'warn' | 'danger' | 'idle'

/** WeLink 自动回复运行状态灯（读聚合 status，文案仍以 statusText 为唯一口径） */
const welinkTone = computed<Tone>(() => {
  switch (welinkStore.status) {
    case 'running':
      return 'ok'
    case 'backoff':
      return 'warn'
    case 'panic':
      return 'danger'
    default:
      return 'idle'
  }
})

/** CodeHub 同步状态灯：三态不混说 —— 待同步 / 无仓库 / 有失败 / 正常带最近同步时间 */
const codehubSync = computed<{ tone: Tone; text: string }>(() => {
  if (!codehubReady.value) return { tone: 'idle', text: '快照待同步' }
  if (!codehubStore.repos.length) return { tone: 'idle', text: '尚未注册仓库' }
  const states = Object.values(codehubStore.syncStates)
  if (states.some((state) => state.lastError)) return { tone: 'warn', text: '部分仓库同步失败' }
  // lastSyncedAt 是 'YYYY-MM-DD HH:MM:SS'，字典序即时间序
  const latest = states
    .map((state) => state.lastSyncedAt)
    .filter((stamp): stamp is string => Boolean(stamp))
    .sort()
    .at(-1)
  return { tone: 'ok', text: latest ? `最近同步 ${shortStamp(latest)}` : '尚未完成同步' }
})

/** CodeHub 空态文案：未装载 / 未注册仓库 / 确实没有开启中的 MR，三态不混说 */
const codehubEmpty = computed(() => {
  if (!codehubReady.value) return { title: '快照待同步', hint: '进入检视页完成一次同步后展示' }
  if (!codehubStore.repos.length) return { title: '尚未注册仓库', hint: '在检视页注册仓库并同步快照' }
  return { title: '没有开启中的 MR', hint: '开启的合并请求会汇总在这里' }
})

/** 存储状态只给结论（正常/降级）：完整原因走 title 提示，长文案不在横条里铺开 */
const storageInfo = computed(() => appStore.info?.storage ?? null)
</script>

<template>
  <div class="page">
    <div class="page-title">
      <h1>工作台</h1>
      <span class="caption">WeLink 与 CodeHub 动态汇总</span>
    </div>

    <!-- 双域状态面板：业务域只有 WeLink（助手 + 快速建群）与 CodeHub（检视） -->
    <section class="domains" aria-label="工作域概览">
      <section class="panel" aria-label="WeLink 域概览">
        <button class="panel__head pressable" @click="router.push('/welink')">
          <span class="panel__badge" aria-hidden="true">
            <IconActivity class="panel__icon" />
          </span>
          <span class="panel__meta">
            <span class="panel__title">WeLink 助手</span>
            <span class="panel__desc">消息存档与自动回复</span>
          </span>
          <IconArrowRight class="panel__arrow" />
        </button>

        <div class="panel__stats">
          <span class="stat">
            <span class="stat__num num">{{ fmt(welinkStore.unreadTotal) }}</span>
            <span class="stat__label">未读消息</span>
          </span>
          <span class="stat" :class="{ 'stat--alert': welinkStore.reviewCount > 0 }">
            <span class="stat__num num">{{ fmt(welinkStore.reviewCount) }}</span>
            <span class="stat__label">待审回复</span>
          </span>
          <span class="stat">
            <span class="stat__num num">{{ fmt(groupStore.templates.length) }}</span>
            <span class="stat__label">建群模板</span>
          </span>
        </div>

        <div class="panel__foot">
          <span class="status" :class="`status--${welinkTone}`">
            <span class="status__dot" aria-hidden="true" />
            自动回复{{ welinkStore.statusText }}
          </span>
          <span class="panel__extra num">历史建群 {{ fmt(groupCount) }} 次</span>
        </div>

        <div class="panel__actions">
          <button class="entry pressable" @click="router.push('/welink')">
            打开助手 <IconArrowRight class="entry__icon" />
          </button>
          <button class="entry pressable" @click="router.push('/groups')">
            <IconUsers class="entry__icon" /> 快速建群 <IconArrowRight class="entry__icon" />
          </button>
        </div>
      </section>

      <section class="panel" aria-label="CodeHub 域概览">
        <button class="panel__head pressable" @click="router.push('/codehub')">
          <span class="panel__badge" aria-hidden="true">
            <IconGitBranch class="panel__icon" />
          </span>
          <span class="panel__meta">
            <span class="panel__title">CodeHub 检视</span>
            <span class="panel__desc">内网 MR 合并与检视动态</span>
          </span>
          <IconArrowRight class="panel__arrow" />
        </button>

        <div class="panel__stats">
          <span class="stat">
            <span class="stat__num num">{{ codehubReady ? fmt(openMrCount) : '待同步' }}</span>
            <span class="stat__label">开启中的 MR</span>
          </span>
          <span class="stat">
            <span class="stat__num num">{{ fmt(codehubStore.repos.length) }}</span>
            <span class="stat__label">注册仓库</span>
          </span>
          <span class="stat">
            <span class="stat__num">{{ codehubStore.autoOn ? '开' : '关' }}</span>
            <span class="stat__label">自动同步</span>
          </span>
        </div>

        <div class="panel__foot">
          <span class="status" :class="`status--${codehubSync.tone}`">
            <span class="status__dot" aria-hidden="true" />
            {{ codehubSync.text }}
          </span>
        </div>

        <div class="panel__actions">
          <button class="entry pressable" @click="router.push('/codehub')">
            去检视 <IconArrowRight class="entry__icon" />
          </button>
        </div>
      </section>
    </section>

    <!-- 双域待办队列：与上方两面板一一对位 -->
    <div class="grid">
      <section class="ht-card" aria-label="待审回复队列">
        <header class="ht-card__head">
          <span>待审回复</span>
          <span v-if="welinkStore.reviewCount" class="count num">{{ welinkStore.reviewCount }}</span>
          <span class="spacer" />
          <button class="link pressable" @click="router.push('/welink')">
            去处理 <IconArrowRight class="link__icon" />
          </button>
        </header>
        <div v-if="reviewQueue.length" class="queue">
          <button v-for="job in reviewQueue" :key="job.pk" class="queue__row pressable" @click="router.push('/welink')">
            <span class="queue__main">
              <span class="queue__title">{{ job.targetTitle || job.targetId }}</span>
              <span class="queue__sub">{{ job.triggerSummary || '（无摘要）' }}</span>
            </span>
            <span v-if="job.holdReason" class="queue__tag">{{ welinkStore.holdLabel(job.holdReason) }}</span>
            <span class="queue__time num">{{ shortStamp(job.createdAt) }}</span>
          </button>
        </div>
        <div v-else class="empty">
          <IconCheck class="empty__icon" />
          <p>暂无待审</p>
          <span class="empty__hint">自动回复平稳运行，无需人工处理</span>
        </div>
      </section>

      <section class="ht-card" aria-label="开启中的 MR">
        <header class="ht-card__head">
          <span>开启中的 MR</span>
          <span v-if="codehubReady && openMrCount" class="count count--muted num">{{ openMrCount }}</span>
          <span class="spacer" />
          <button class="link pressable" @click="router.push('/codehub')">
            去检视 <IconArrowRight class="link__icon" />
          </button>
        </header>
        <div v-if="openMrs.length" class="queue">
          <button
            v-for="mr in openMrs"
            :key="`${mr.summary.repoId}#${mr.summary.mrIid}`"
            class="queue__row pressable"
            @click="router.push('/codehub')"
          >
            <span class="queue__main">
              <span class="queue__title">{{ mr.summary.title }}</span>
              <span class="queue__sub num">
                {{ mr.summary.repoId }} · {{ mr.summary.sourceBranch }} → {{ mr.summary.targetBranch }}
              </span>
            </span>
            <span class="queue__time num">{{ shortStamp(mr.summary.updatedAt) }}</span>
          </button>
        </div>
        <div v-else class="empty">
          <IconGitBranch class="empty__icon" />
          <p>{{ codehubEmpty.title }}</p>
          <span class="empty__hint">{{ codehubEmpty.hint }}</span>
        </div>
      </section>
    </div>

    <!-- 运行信息横条：次要系统信息，压缩到底部一行 -->
    <section class="ht-card" aria-label="运行信息">
      <header class="ht-card__head">
        <span>运行信息</span>
        <span class="spacer" />
        <button class="icon-btn pressable" title="刷新" aria-label="刷新运行信息" @click="appStore.load()">
          <IconRefresh class="icon-btn__icon" />
        </button>
      </header>
      <dl class="runtime">
        <div class="runtime__item">
          <dt>运行模式</dt>
          <dd>{{ platformLabel === '桌面' ? 'Tauri 桌面' : 'Web 浏览器' }}</dd>
        </div>
        <div class="runtime__item">
          <dt>应用版本</dt>
          <dd class="num">
            v{{ appStore.info?.version ?? '-' }}
            <span
              v-if="updateStore.hasUpdate"
              class="update-dot"
              :title="`发现新版本 ${updateStore.status.latest?.version ?? updateStore.status.hintVersion ?? ''}，可在配置页安装`"
            />
          </dd>
        </div>
        <div class="runtime__item">
          <dt>系统 / 架构</dt>
          <dd>{{ appStore.info ? `${appStore.info.platform} / ${appStore.info.arch}` : '-' }}</dd>
        </div>
        <div class="runtime__item runtime__item--wide">
          <dt>数据根目录</dt>
          <dd class="mono" :title="storageInfo?.root">{{ storageInfo?.root ?? '-' }}</dd>
        </div>
        <div v-if="storageInfo" class="runtime__item">
          <dt>存储状态</dt>
          <dd>
            <span class="pill" :class="storageInfo.fallback ? 'pill--warn' : 'pill--ok'" :title="storageInfo.note">
              {{ storageInfo.fallback ? '降级' : '正常' }}
            </span>
          </dd>
        </div>
      </dl>
    </section>
  </div>
</template>

<style scoped>
/* —— 双域状态面板 —— */
.domains {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(340px, 1fr));
  gap: 14px;
}

.panel {
  display: flex;
  flex-direction: column;
  gap: 13px;
  padding: 16px;
  border: 1px solid var(--ht-line);
  border-radius: var(--ht-radius);
  background: var(--ht-surface);
}

.panel__head {
  display: flex;
  align-items: center;
  gap: 12px;
  width: 100%;
  padding: 0;
  border: none;
  background: none;
  font: inherit;
  text-align: left;
  cursor: pointer;
  min-width: 0;
}

.panel__badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 38px;
  height: 38px;
  border-radius: 10px;
  background: var(--ht-primary-soft);
  color: var(--ht-primary);
  flex-shrink: 0;
}

.panel__icon {
  width: 20px;
  height: 20px;
}

.panel__meta {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
  flex: 1;
}

.panel__title {
  font-size: 15px;
  font-weight: 600;
  color: var(--ht-text-1);
  transition: color 0.15s;
}

.panel__head:hover .panel__title {
  color: var(--ht-primary);
}

.panel__desc {
  font-size: 12px;
  color: var(--ht-text-3);
}

/* 箭头 hover 才出现：常驻是噪音，hover 是导航暗示 */
.panel__arrow {
  width: 15px;
  height: 15px;
  color: var(--ht-primary);
  flex-shrink: 0;
  opacity: 0;
  transition: opacity 0.15s;
}

.panel__head:hover .panel__arrow,
.panel__head:focus-visible .panel__arrow {
  opacity: 1;
}

.panel__stats {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 10px;
}

.stat {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 10px 12px;
  border: 1px solid var(--ht-line);
  border-radius: var(--ht-radius-sm);
  background: var(--ht-surface-2);
  min-width: 0;
}

.stat__num {
  font-size: 20px;
  font-weight: 600;
  line-height: 1.15;
  color: var(--ht-text-1);
  letter-spacing: -0.01em;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.stat__label {
  font-size: 11.5px;
  color: var(--ht-text-3);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* 待审 > 0 是需要行动的信号，数字给语义红 */
.stat--alert .stat__num {
  color: var(--ht-danger);
}

.panel__foot {
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
}

.status {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  font-size: 12px;
  color: var(--ht-text-2);
  min-width: 0;
}

.status__dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--ht-text-3);
  flex-shrink: 0;
}

.status--ok .status__dot {
  background: var(--ht-ok);
}

.status--warn .status__dot {
  background: var(--ht-warn);
}

.status--danger .status__dot {
  background: var(--ht-danger);
}

.panel__extra {
  margin-left: auto;
  font-size: 11.5px;
  color: var(--ht-text-3);
  white-space: nowrap;
}

.panel__actions {
  display: flex;
  gap: 8px;
}

.entry {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  border: 1px solid var(--ht-line);
  border-radius: 8px;
  background: var(--ht-surface);
  font: inherit;
  font-size: 12.5px;
  font-weight: 500;
  color: var(--ht-text-2);
  cursor: pointer;
}

.entry:hover {
  color: var(--ht-primary);
  border-color: var(--ht-primary-line);
  background: var(--ht-primary-soft);
}

.entry__icon {
  width: 13px;
  height: 13px;
}

/* —— 双列待办队列（窄屏堆叠） —— */
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(360px, 1fr));
  gap: 14px;
  align-items: start;
}

/* —— 待办队列 —— */
.count {
  min-width: 18px;
  height: 18px;
  padding: 0 6px;
  border-radius: 9px;
  background: var(--ht-danger);
  color: #fff;
  font-size: 10.5px;
  line-height: 18px;
  text-align: center;
  font-variant-numeric: tabular-nums;
}

.count--muted {
  background: var(--ht-surface-2);
  color: var(--ht-text-2);
}

.queue {
  display: flex;
  flex-direction: column;
}

.queue__row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 16px;
  border: none;
  border-top: 1px solid var(--ht-line);
  background: var(--ht-surface);
  font: inherit;
  text-align: left;
  cursor: pointer;
  min-width: 0;
}

.queue__row:first-child {
  border-top: none;
}

.queue__row:hover {
  background: var(--ht-surface-2);
}

.queue__main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.queue__title {
  font-size: 12.5px;
  font-weight: 500;
  color: var(--ht-text-1);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.queue__sub {
  font-size: 11.5px;
  color: var(--ht-text-3);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.queue__tag {
  flex-shrink: 0;
  font-size: 11px;
  padding: 1px 7px;
  border-radius: 5px;
  background: var(--el-color-warning-light-9);
  color: var(--ht-warn);
  white-space: nowrap;
}

.queue__time {
  flex-shrink: 0;
  font-size: 11px;
  color: var(--ht-text-3);
}

/* —— 链接按钮 —— */
.link {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  border: none;
  background: none;
  padding: 2px 4px;
  border-radius: 6px;
  font: inherit;
  font-size: 12.5px;
  color: var(--ht-primary);
  cursor: pointer;
}

.link:hover {
  color: var(--ht-primary-strong);
  background: var(--ht-primary-soft);
}

.link__icon {
  width: 13px;
  height: 13px;
}

.icon-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border: 1px solid transparent;
  border-radius: 7px;
  background: transparent;
  color: var(--ht-text-3);
  cursor: pointer;
}

.icon-btn:hover {
  color: var(--ht-text-1);
  border-color: var(--ht-line);
  background: var(--ht-surface-2);
}

.icon-btn__icon {
  width: 14px;
  height: 14px;
}

/* —— 运行信息横条 —— */
.runtime {
  display: flex;
  flex-wrap: wrap;
  gap: 10px 30px;
  margin: 0;
  padding: 13px 16px;
}

.runtime__item {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}

/* 路径类长值放宽上限，其余项按内容收缩 */
.runtime__item--wide {
  flex: 1 1 220px;
  max-width: 420px;
}

.runtime__item dt {
  font-size: 11px;
  color: var(--ht-text-3);
  white-space: nowrap;
}

.runtime__item dd {
  margin: 0;
  font-size: 12.5px;
  color: var(--ht-text-1);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 存储状态降级 = 橙点（正常复用全局 pill--ok 绿点） */
.pill--warn::before {
  background: var(--ht-warn);
}

/* 自动更新小红点（design-auto-update：工作台仅提示不操作） */
.update-dot {
  display: inline-block;
  width: 7px;
  height: 7px;
  margin-left: 5px;
  border-radius: 50%;
  background: var(--ht-danger);
  vertical-align: 2px;
  cursor: help;
}

/* —— 空态 —— */
.empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  padding: 26px 16px;
  color: var(--ht-text-3);
  font-size: 13px;
}

.empty p {
  margin: 2px 0 0;
}

.empty__icon {
  width: 22px;
  height: 22px;
  opacity: 0.5;
}

.empty__hint {
  font-size: 11.5px;
  color: var(--ht-text-3);
  opacity: 0.85;
}
</style>
