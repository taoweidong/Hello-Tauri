<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import {
  IconTable,
  IconRefresh,
  IconArrowRight,
  IconActivity,
  IconUsers,
  IconGitBranch,
  IconCircleCheck,
  IconCheck,
} from '@/components/icons'

import { platform } from '@/api'
import type { CodeHubMrRecord } from '@/types/codehub'
import type { WelinkJob } from '@/types/welink'
import { useAppStore } from '@/stores/app'
import { useWelinkStore } from '@/stores/welink'
import { useCodehubStore } from '@/stores/codehub'
import { useGroupStore } from '@/stores/group'
import { CATEGORIES, useTableStore } from '@/stores/table'
import { logger } from '@/utils/logger'
import { shortStamp } from '@/utils/welink-display'

const router = useRouter()
const appStore = useAppStore()
const welinkStore = useWelinkStore()
const codehubStore = useCodehubStore()
const groupStore = useGroupStore()
const tableStore = useTableStore()

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

// ---------------- 工作域状态卡（spec「首页域卡片聚合」） ----------------

const domainCards = computed(() => [
  {
    path: '/welink',
    title: 'WeLink 助手',
    desc: '消息存档与自动回复',
    strong: fmt(welinkStore.reviewCount),
    unit: '条待审',
    sub: `未读 ${fmt(welinkStore.unreadTotal)} · ${welinkStore.statusText}`,
    icon: IconActivity,
  },
  {
    path: '/groups',
    title: '快速建群',
    desc: '建群模板与全程留痕',
    strong: fmt(groupStore.templates.length),
    unit: '套模板',
    sub: `历史建群 ${fmt(groupCount.value)} 次`,
    icon: IconUsers,
  },
  {
    path: '/codehub',
    title: 'CodeHub 检视',
    desc: '内网 MR 合并与检视动态',
    strong: codehubReady.value ? fmt(openMrCount.value) : '待同步',
    unit: codehubReady.value ? '个开启' : '',
    sub: `${codehubStore.repos.length} 个仓库 · 自动同步${codehubStore.autoOn ? '开' : '关'}`,
    icon: IconGitBranch,
  },
  {
    path: '/table',
    title: '数据管理',
    desc: '本地记录与导出',
    strong: fmt(tableStore.stats.total),
    unit: '条记录',
    sub: `金额合计 ${fmt(tableStore.stats.amount)} 元`,
    icon: IconTable,
  },
  {
    path: '/envcheck',
    title: '环境检测',
    desc: '系统诊断与依赖探测',
    strong: '一键体检',
    unit: '',
    sub: `只读诊断 · ${platformLabel.value}模式`,
    icon: IconCircleCheck,
  },
])

// ---------------- 待办队列（跨域聚合的核心内容） ----------------

/** 分类分布：条数占比，供色带条使用 */
const distribution = computed(() => {
  const total = tableStore.rows.length || 1
  return CATEGORIES.map((cat, i) => {
    const rows = tableStore.rows.filter((row) => row.category === cat)
    return { name: cat, count: rows.length, pct: Math.round((rows.length / total) * 100), idx: i }
  }).sort((a, b) => b.count - a.count)
})

/** CodeHub 空态文案：未装载 / 未注册仓库 / 确实没有开启中的 MR，三态不混说 */
const codehubEmpty = computed(() => {
  if (!codehubReady.value) return { title: '快照待同步', hint: '进入检视页完成一次同步后展示' }
  if (!codehubStore.repos.length) return { title: '尚未注册仓库', hint: '在检视页注册仓库并同步快照' }
  return { title: '没有开启中的 MR', hint: '开启的合并请求会汇总在这里' }
})

/** 存储状态只给结论（正常/降级）：完整原因走 title 提示，长文案不在 320px 侧栏里换行铺开 */
const storageInfo = computed(() => appStore.info?.storage ?? null)

const infoRows = computed(() => [
  { label: '运行模式', value: platformLabel.value === '桌面' ? 'Tauri 桌面' : 'Web 浏览器' },
  { label: '应用版本', value: appStore.info?.version ?? '-' },
  { label: 'Tauri 版本', value: appStore.info?.tauriVersion ?? '-' },
  { label: '系统 / 架构', value: appStore.info ? `${appStore.info.platform} / ${appStore.info.arch}` : '-' },
  { label: '配置文件', value: appStore.info?.configPath ?? '-', mono: true },
  { label: '数据根目录', value: storageInfo.value?.root ?? '-', mono: true },
])
</script>

<template>
  <div class="page">
    <div class="page-title">
      <h1>工作台</h1>
      <span class="caption">各工作域入口与数据摘要</span>
    </div>

    <!-- 工作域状态卡：个人工作台的聚合入口（spec「首页域卡片聚合」） -->
    <section class="domains" aria-label="工作域入口">
      <button v-for="card in domainCards" :key="card.path" class="domain pressable" @click="router.push(card.path)">
        <span class="domain__top">
          <span class="domain__badge" aria-hidden="true">
            <component :is="card.icon" class="domain__icon" />
          </span>
          <span class="domain__meta">
            <span class="domain__title">{{ card.title }}</span>
            <span class="domain__desc">{{ card.desc }}</span>
          </span>
          <IconArrowRight class="domain__arrow" />
        </span>
        <span class="domain__metric">
          <span class="domain__strong num">{{ card.strong }}</span>
          <span v-if="card.unit" class="domain__unit">{{ card.unit }}</span>
        </span>
        <span class="domain__sub" :title="card.sub">{{ card.sub }}</span>
      </button>
    </section>

    <div class="grid">
      <!-- 左：跨域待办队列 -->
      <div class="stack">
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

      <!-- 右：分类分布 + 运行信息 -->
      <div class="side">
        <section class="ht-card">
          <header class="ht-card__head">分类分布</header>
          <div class="ht-card__body dist">
            <div v-for="item in distribution" :key="item.name" class="dist__row">
              <span class="dot" :class="`dot--${item.idx}`" aria-hidden="true" />
              <span class="dist__name">{{ item.name }}</span>
              <span class="dist__track"
                ><span class="dist__fill" :class="`dot--${item.idx}`" :style="{ width: item.pct + '%' }"
              /></span>
              <span class="dist__num num">{{ item.count }}</span>
            </div>
          </div>
        </section>

        <section class="ht-card">
          <header class="ht-card__head">
            <span>运行信息</span>
            <span class="spacer" />
            <button class="icon-btn pressable" title="刷新" aria-label="刷新运行信息" @click="appStore.load()">
              <IconRefresh class="icon-btn__icon" />
            </button>
          </header>
          <dl class="kv">
            <template v-for="row in infoRows" :key="row.label">
              <dt>{{ row.label }}</dt>
              <dd :class="{ mono: row.mono }">{{ row.value }}</dd>
            </template>
            <!-- 存储状态（design D7 卡片项）：结论 + 语义色点，完整原因进 title -->
            <template v-if="storageInfo">
              <dt>存储状态</dt>
              <dd>
                <span class="pill" :class="storageInfo.fallback ? 'pill--warn' : 'pill--ok'" :title="storageInfo.note">
                  {{ storageInfo.fallback ? '降级' : '正常' }}
                </span>
              </dd>
            </template>
          </dl>
        </section>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* —— 工作域状态卡 —— */
.domains {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(196px, 1fr));
  gap: 12px;
}

.domain {
  display: flex;
  flex-direction: column;
  gap: 9px;
  padding: 13px 15px;
  border: 1px solid var(--ht-line);
  border-radius: var(--ht-radius);
  background: var(--ht-surface);
  font: inherit;
  text-align: left;
  cursor: pointer;
  min-width: 0;
}

.domain:hover {
  border-color: var(--ht-primary);
}

.domain__top {
  display: flex;
  align-items: center;
  gap: 10px;
}

.domain__badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  border-radius: 8px;
  background: var(--ht-primary-soft);
  color: var(--ht-primary);
  flex-shrink: 0;
}

.domain__icon {
  width: 17px;
  height: 17px;
}

.domain__meta {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
  flex: 1;
}

.domain__title {
  font-size: 13.5px;
  font-weight: 600;
  color: var(--ht-text-1);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.domain__desc {
  font-size: 11.5px;
  color: var(--ht-text-3);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* 箭头 hover 才出现：常驻是噪音，hover 是导航暗示 */
.domain__arrow {
  width: 14px;
  height: 14px;
  color: var(--ht-primary);
  flex-shrink: 0;
  opacity: 0;
  transition: opacity 0.15s;
}

.domain:hover .domain__arrow,
.domain:focus-visible .domain__arrow {
  opacity: 1;
}

.domain__metric {
  display: flex;
  align-items: baseline;
  gap: 5px;
}

.domain__strong {
  font-size: 22px;
  font-weight: 600;
  line-height: 1.1;
  color: var(--ht-text-1);
  letter-spacing: -0.01em;
}

.domain__unit {
  font-size: 12px;
  color: var(--ht-text-2);
}

.domain__sub {
  font-size: 11.5px;
  color: var(--ht-text-3);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* —— 双栏布局 —— */
.grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 320px;
  gap: 14px;
  align-items: start;
}

@media (max-width: 1180px) {
  .grid {
    grid-template-columns: 1fr;
  }
}

.stack,
.side {
  display: flex;
  flex-direction: column;
  gap: 14px;
  min-width: 0;
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

/* —— 分类分布 —— */
.dist {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 14px 16px;
}

.dist__row {
  display: grid;
  grid-template-columns: 8px 84px 1fr 28px;
  align-items: center;
  gap: 9px;
}

.dist__name {
  font-size: 12px;
  color: var(--ht-text-2);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dist__track {
  height: 4px;
  border-radius: 2px;
  background: var(--ht-surface-2);
  overflow: hidden;
}

.dist__fill {
  display: block;
  height: 100%;
  border-radius: 2px;
  transition: width 0.4s cubic-bezier(0.22, 0.61, 0.36, 1);
}

.dist__num {
  font-size: 12px;
  color: var(--ht-text-3);
  text-align: right;
}

/* —— 键值信息 —— */
.kv {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 0;
  margin: 0;
  padding: 6px 0;
}

.kv dt {
  padding: 7px 16px;
  font-size: 12px;
  color: var(--ht-text-3);
  white-space: nowrap;
}

.kv dd {
  padding: 7px 16px 7px 0;
  margin: 0;
  font-size: 12.5px;
  color: var(--ht-text-1);
  text-align: right;
  overflow-wrap: anywhere;
}

/* 每行成对分隔线：第二对起画顶部 hairline */
.kv > dt:not(:first-of-type),
.kv > dd:not(:first-of-type) {
  border-top: 1px solid var(--ht-line);
}

/* 存储状态降级 = 橙点（正常复用全局 pill--ok 绿点） */
.pill--warn::before {
  background: var(--ht-warn);
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
