<script setup lang="ts">
/**
 * CodeHub 检视页（personal-workbench）。
 *
 * 数据纪律（spec「检视页筛选与详情」「快照落库与离线只读降级」）：
 *  * **浏览只读快照**：进入页面与切筛选只查本地库，绝不顺手触发子进程 ——
 *    手动刷新按钮是唯一的批量同步入口；
 *  * **详情按条补拉**：快照缺详情时，点开那一条会经编排层补拉一次 `mr view`
 *    并回填快照（同条在飞去重、失败不阻塞浏览）—— 这是浏览态唯一的子进程出口；
 *  * **离线只读降级**：CLI 不可用不影响浏览，状态条标注最后同步时间（非实时）；
 *  * **未配置引导态**：CLI 模式且配置不齐时整页只显示引导卡（不发任何调用）。
 *
 * UI 层不直触 infra：全部动作经 `useCodehubStore`（D2 组合点例外在 store）。
 */
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'

import { IconAlert, IconGitBranch, IconPlus, IconRefresh, IconTrash } from '@/components/icons'
import MrDetailPanel from '@/components/codehub/MrDetailPanel.vue'
import MrStateBadge from '@/components/codehub/MrStateBadge.vue'
import type { CodeHubMrRecord, CodeHubMrState } from '@/types/codehub'
import { CODEHUB_STATE_LABEL } from '@/types/codehub'
import { useCodehubStore } from '@/stores/codehub'
import { useAppStore } from '@/stores/app'
import { logger } from '@/utils/logger'

const router = useRouter()
const appStore = useAppStore()
const store = useCodehubStore()

/** 状态筛选条选项（'' = 全部），标签取 `CODEHUB_STATE_LABEL` 单一真值 */
const STATE_OPTIONS: Array<'' | CodeHubMrState> = ['', 'open', 'merged', 'closed']

/** 页面装载完成（init 幂等）；失败时进「装载失败」态并给出重试，而不是永远「装载中」 */
const ready = ref(false)
const initFailed = ref(false)

// ---------------- 浏览状态（筛选/选中归视图持有，store 不复制） ----------------

const stateFilter = ref<'' | CodeHubMrState>('')
const selectedRepo = ref<string>('') // '' = 全部仓库
const items = ref<CodeHubMrRecord[]>([])
const total = ref(0)
/** 单页上限：本地快照的个人清单量级，超出提示用筛选收窄 */
const PAGE_SIZE = 200

/** 来源徽标：由配置派生（响应式），不直触 infra 端口缓存 */
const sourceBadge = computed(() => (store.source === 'mock' ? '模拟数据' : 'CLI'))
const canBrowse = computed(() => ready.value && store.configured)

/** 从未同步过（无任何仓库同步状态）→ 空态文案区分「没数据」与「筛完为空」 */
const neverSynced = computed(() => Object.keys(store.syncStates).length === 0)

/** 按仓库分组（组内保持 updated_at 倒序），列表浏览只读快照 */
const groupedItems = computed(() => {
  const groups = new Map<string, CodeHubMrRecord[]>()
  for (const record of items.value) {
    const bucket = groups.get(record.summary.repoId) ?? []
    bucket.push(record)
    groups.set(record.summary.repoId, bucket)
  }
  return [...groups.entries()].map(([repoId, records]) => ({ repoId, records }))
})

async function reload() {
  const query: { repoId?: string; state?: CodeHubMrState; limit: number; offset: number } = {
    limit: PAGE_SIZE,
    offset: 0,
  }
  if (selectedRepo.value) query.repoId = selectedRepo.value
  if (stateFilter.value) query.state = stateFilter.value
  const [rows, count] = await Promise.all([
    store.listMrs(query),
    store.countMrs({ repoId: query.repoId, state: query.state }),
  ])
  items.value = rows
  total.value = count
  if (total.value > PAGE_SIZE) {
    // 个人工具量级下不应出现；出现说明快照异常膨胀，提示收窄而不是静默截断
    logger.warn(`CodeHub 快照记录数 ${total.value} 超过单页上限 ${PAGE_SIZE}，请用筛选收窄`)
  }
}

// ---------------- 详情 ----------------

const selected = ref<CodeHubMrRecord | null>(null)
const detailLoading = ref(false)

async function openDetail(record: CodeHubMrRecord) {
  selected.value = record
  if (record.detail) return
  // 快照缺详情 → 经编排层补拉（同条在飞去重，失败退回列表字段占位）
  detailLoading.value = true
  try {
    const fresh = await store.getMr(record.summary.repoId, record.summary.mrIid)
    if (fresh) selected.value = fresh
  } finally {
    detailLoading.value = false
  }
}

function closeDetail() {
  selected.value = null
}

// ---------------- 同步 ----------------

const refreshing = ref(false)
const refreshHint = ref('')

/** 上一轮的截断降级告警（design D5）：成功轮也可能「少了尾巴」，必须让用户看到 */
const degradedHint = computed(() => {
  const count = store.lastSummary?.degraded.length ?? 0
  return count ? `${count} 个仓库输出被截断，快照可能不完整` : ''
})

async function refresh() {
  refreshing.value = true
  refreshHint.value = ''
  try {
    const summary = await store.refresh()
    if (summary.phase === 'failed') refreshHint.value = summary.reason
  } finally {
    refreshing.value = false
    await reload()
  }
}

// ---------------- 仓库注册 ----------------

const newRepoId = ref('')
const repoError = ref('')
/** 两步删除确认（避免引入弹窗组件：点一次变「确认删除」，失焦还原） */
const pendingRemovePk = ref<number | null>(null)

async function addRepo() {
  repoError.value = ''
  try {
    await store.addRepo(newRepoId.value, '')
    newRepoId.value = ''
  } catch (error) {
    repoError.value = error instanceof Error ? error.message : String(error)
  }
  await reload()
}

async function toggleRepo(pk: number, enabled: boolean) {
  repoError.value = ''
  try {
    await store.setRepoEnabled(pk, enabled)
  } catch (error) {
    repoError.value = error instanceof Error ? error.message : String(error)
    // 失败时把清单读回真值：否则复选框停在用户刚点出来的假状态，看不出没生效
    await store.loadRepos()
  }
  await Promise.all([reload(), store.loadSyncStates()])
}

async function removeRepo(pk: number) {
  if (pendingRemovePk.value !== pk) {
    pendingRemovePk.value = pk
    return
  }
  pendingRemovePk.value = null
  const removed = store.repos.find((repo) => repo.pk === pk)
  try {
    await store.removeRepo(pk)
    // 删掉的仓库若正被筛选/详情引用，视图状态必须一起收口，否则会停在空筛选上
    if (removed && selectedRepo.value === removed.repoId) selectedRepo.value = ''
    if (removed && selected.value?.summary.repoId === removed.repoId) selected.value = null
  } catch (error) {
    repoError.value = error instanceof Error ? error.message : String(error)
  }
  await reload()
}

/** 选中仓库并重新查快照（仓库按钮与「全部仓库」共用） */
function selectRepo(repoId: string) {
  selectedRepo.value = repoId
  void reload()
}

/** 切状态筛选并重新查快照（列表与计数同一口径，见 reload） */
function selectState(option: '' | CodeHubMrState) {
  stateFilter.value = option
  void reload()
}

/** 装载：init 失败（表结构/数据目录不可用）落到可重试的失败态 */
async function load() {
  ready.value = false
  initFailed.value = false
  const ok = await store.init()
  ready.value = ok
  initFailed.value = !ok
  // 未配置时整页只出引导卡，连本地快照都不必查（配置齐全后重新进入页面才装载列表）
  if (ok && store.configured) await reload()
}

onMounted(load)
</script>

<template>
  <div class="page">
    <div class="page-title">
      <h1>CodeHub 检视</h1>
      <span class="caption">内网 MR 合并与检视动态（本地快照，只读）</span>
    </div>

    <!-- 未配置引导态：CLI 模式且配置不齐时不渲染任何数据区（不发任何调用） -->
    <section v-if="ready && !store.configured" class="ht-card guide" aria-label="未配置引导">
      <IconGitBranch class="guide__icon" />
      <h2 class="guide__title">尚未配置 codehub-cli</h2>
      <p class="guide__text">
        需要 codehub-cli 可执行文件路径与访问 token 才能拉取内网 MR。 浏览与同步全部走本地快照，配置完成后即可使用。
      </p>
      <button class="btn btn--primary" @click="router.push('/settings')">去配置页填写</button>
    </section>

    <template v-else-if="canBrowse">
      <!-- 状态条：同步动作 + 健康度（最后同步时间 / 退避 / 失败原因） -->
      <section class="toolbar" aria-label="同步状态">
        <button class="btn btn--primary" :disabled="store.syncing || refreshing" @click="refresh">
          <IconRefresh class="btn__icon" :class="{ 'is-spinning': store.syncing || refreshing }" />
          {{ store.syncing || refreshing ? '同步中…' : '同步' }}
        </button>
        <span class="tag">{{ sourceBadge }}</span>
        <span v-if="store.autoOn" class="tag tag--live">自动 · {{ store.effectiveIntervalSec }}s</span>
        <span v-if="store.backoffSec > 0" class="tag">退避 {{ store.backoffSec }}s</span>
        <span v-if="degradedHint" class="tag tag--degraded">{{ degradedHint }}</span>
        <span v-if="refreshHint" class="toolbar__error">{{ refreshHint }}</span>
        <span class="spacer" />
        <span v-if="store.lastSummary" class="toolbar__summary">
          {{ store.lastSummary.phase === 'ok' ? '最近同步成功' : '最近同步失败' }} · {{ store.lastSummary.finishedAt }}
        </span>
      </section>

      <div class="layout">
        <!-- 左：仓库注册与清单（分组浏览的骨架） -->
        <aside class="repos" aria-label="仓库清单">
          <div class="repos__add">
            <input
              v-model="newRepoId"
              class="repos__input"
              placeholder="仓库标识，如 space/repo"
              @keyup.enter="addRepo"
            />
            <button class="btn" :aria-label="'注册仓库'" @click="addRepo"><IconPlus class="btn__icon" /></button>
          </div>
          <p v-if="repoError" class="repos__error">{{ repoError }}</p>

          <button class="repo repo--all" :class="{ 'is-active': selectedRepo === '' }" @click="selectRepo('')">
            <span class="repo__name">全部仓库</span>
            <span class="repo__meta num">{{ total }}</span>
          </button>

          <div
            v-for="repo in store.repos"
            :key="repo.pk"
            class="repo"
            :class="{ 'is-active': selectedRepo === repo.repoId }"
          >
            <!-- 交互控件不嵌套：复选框必须在 button 之外（button 内不允许放可交互内容） -->
            <button class="repo__main" @click="selectRepo(repo.repoId)">
              <span class="repo__name">{{ repo.name || repo.repoId }}</span>
              <span v-if="store.syncStates[repo.repoId]?.lastError" class="repo__error">
                {{ store.syncStates[repo.repoId]!.lastError }}
              </span>
              <span v-else-if="store.syncStates[repo.repoId]?.lastSyncedAt" class="repo__meta">
                同步于 {{ store.syncStates[repo.repoId]!.lastSyncedAt }}
              </span>
              <span v-else class="repo__meta">从未同步</span>
            </button>
            <label class="repo__toggle">
              <input
                type="checkbox"
                :checked="repo.enabled"
                :aria-label="`启用 ${repo.repoId}`"
                @change="toggleRepo(repo.pk, ($event.target as HTMLInputElement).checked)"
              />
              <span>参与同步</span>
            </label>
            <button
              class="repo__remove pressable"
              :class="{ 'is-armed': pendingRemovePk === repo.pk }"
              :aria-label="`删除 ${repo.repoId}`"
              @blur="pendingRemovePk = null"
              @click="removeRepo(repo.pk)"
            >
              <IconTrash class="repo__remove-icon" />
              {{ pendingRemovePk === repo.pk ? '确认删除' : '' }}
            </button>
          </div>

          <p class="repos__note">仓库清单只存本机；删除会同时清掉该仓库的快照。</p>
        </aside>

        <!-- 右：筛选 + 分组列表 + 详情 -->
        <div class="board">
          <div class="filters" aria-label="状态筛选">
            <button
              v-for="option in STATE_OPTIONS"
              :key="option"
              class="chip"
              :class="{ 'is-active': stateFilter === option }"
              @click="selectState(option)"
            >
              {{ option === '' ? '全部' : CODEHUB_STATE_LABEL[option] }}
            </button>
          </div>

          <div v-if="!items.length" class="ht-card empty" aria-label="空态">
            <IconGitBranch class="empty__icon" />
            <template v-if="neverSynced">
              <p>还没有同步过任何 MR。</p>
              <p class="empty__hint">点击上方「同步」拉取一次内网数据；同步失败也不影响已有快照的浏览。</p>
            </template>
            <template v-else>
              <p>当前筛选下没有 MR。</p>
              <p class="empty__hint">切换状态或仓库范围再试。</p>
            </template>
          </div>

          <div v-else class="list">
            <section v-for="group in groupedItems" :key="group.repoId" class="list__group" :aria-label="group.repoId">
              <header class="list__head">
                <IconGitBranch class="list__head-icon" />
                <span class="list__head-name">{{ group.repoId }}</span>
                <span class="list__head-count num">{{ group.records.length }}</span>
              </header>
              <button
                v-for="record in group.records"
                :key="`${record.summary.repoId}!${record.summary.mrIid}`"
                class="mr"
                :class="{ 'is-open': record.summary.state === 'open' }"
                @click="openDetail(record)"
              >
                <MrStateBadge :state="record.summary.state" />
                <span class="mr__title">{{ record.summary.title }}</span>
                <span class="mr__meta">{{ record.summary.author || '-' }} · {{ record.summary.updatedAt || '-' }}</span>
              </button>
            </section>
          </div>

          <MrDetailPanel v-if="selected" :record="selected" :loading="detailLoading" @close="closeDetail" />
        </div>
      </div>
    </template>

    <!-- 装载失败：给可重试的失败态，而不是永远停在「装载中」 -->
    <section v-else-if="initFailed" class="ht-card empty" aria-label="装载失败">
      <IconAlert class="empty__icon" />
      <p>本地快照装载失败：表结构迁移或数据目录不可用。</p>
      <p class="empty__hint">可在配置页核对数据根目录后重试；重试不会改动已有数据。</p>
      <button class="btn" @click="load">重试</button>
    </section>

    <section v-else class="ht-card empty" aria-label="装载中">
      <p>正在装载本地快照…</p>
    </section>

    <p class="page-foot">
      数据源与 token 在 <button class="link" @click="router.push('/settings')">配置页</button> 维护；{{
        appStore.info ? `当前 ${appStore.info.platform}` : ''
      }}
      列表浏览只读本地快照，不产生网络调用；仅当某条 MR 的快照缺详情时，点开它才会补拉一次
      <span class="mono">mr view</span>。
    </p>
  </div>
</template>

<style scoped>
/* —— 引导态 —— */
.guide {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 8px;
  padding: 28px;
}

.guide__icon {
  width: 28px;
  height: 28px;
  color: var(--ht-primary);
}

.guide__title {
  margin: 0;
  font-size: 16px;
  color: var(--ht-text-1);
}

.guide__text {
  margin: 0 0 6px;
  max-width: 560px;
  font-size: 13px;
  line-height: 1.7;
  color: var(--ht-text-2);
}

/* —— 按钮 / 徽标 —— */
.btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 7px 14px;
  border: 1px solid var(--ht-line);
  border-radius: 8px;
  background: var(--ht-surface);
  color: var(--ht-text-1);
  font: inherit;
  font-size: 12.5px;
  cursor: pointer;
}

.btn:hover {
  border-color: var(--ht-line-strong);
  background: var(--ht-surface-2);
}

.btn:disabled {
  opacity: 0.6;
  cursor: default;
}

.btn--primary {
  border-color: transparent;
  background: var(--ht-primary);
  color: #fff;
}

.btn--primary:hover {
  background: var(--ht-primary-strong);
}

.btn__icon {
  width: 14px;
  height: 14px;
}

.btn__icon.is-spinning {
  animation: spin 0.9s linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

@media (prefers-reduced-motion: reduce) {
  .btn__icon.is-spinning {
    animation: none;
  }
}

/* 状态条小徽标（刻意不用全局 .pill：那款带状态圆点，语义不同） */
.tag {
  padding: 2px 8px;
  border-radius: 999px;
  font-size: 11px;
  background: var(--ht-surface-2);
  color: var(--ht-text-3);
  white-space: nowrap;
}

.tag--live {
  background: var(--ht-primary-soft);
  color: var(--ht-primary-strong);
}

.tag--degraded {
  background: rgba(230, 162, 60, 0.16);
  color: #96601f;
}

/* —— 状态条 —— */
.toolbar {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 14px;
}

.toolbar__error {
  font-size: 12px;
  color: var(--ht-danger);
}

.toolbar__summary {
  font-size: 12px;
  color: var(--ht-text-3);
}

.spacer {
  flex: 1;
}

/* —— 双栏 —— */
.layout {
  display: grid;
  grid-template-columns: 300px minmax(0, 1fr);
  gap: 14px;
  align-items: start;
}

@media (max-width: 1080px) {
  .layout {
    grid-template-columns: 1fr;
  }
}

/* —— 仓库清单 —— */
.repos {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.repos__add {
  display: flex;
  gap: 6px;
}

.repos__input {
  flex: 1;
  min-width: 0;
  padding: 7px 10px;
  border: 1px solid var(--ht-line);
  border-radius: 8px;
  background: var(--ht-surface);
  color: var(--ht-text-1);
  font: inherit;
  font-size: 12.5px;
}

.repos__input:focus-visible {
  outline: 2px solid var(--ht-primary);
  outline-offset: -1px;
}

.repos__error {
  margin: 0;
  font-size: 12px;
  color: var(--ht-danger);
}

.repo {
  position: relative;
  border: 1px solid var(--ht-line);
  border-radius: 10px;
  background: var(--ht-surface);
  overflow: hidden;
}

.repo.is-active {
  border-color: var(--ht-primary);
}

/* 「全部仓库」这一行本身就是按钮：padding 不能只写在 .repo__main 上 */
.repo--all {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 10px 12px;
  border: none;
  background: var(--ht-surface);
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.repo--all:hover {
  background: var(--ht-surface-2);
}

.repo--all .repo__meta {
  margin-left: auto;
}

.repo__main {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 4px;
  width: 100%;
  /* 右上留白给绝对定位的删除按钮，长仓库名不压在图标下 */
  padding: 10px 44px 6px 12px;
  border: none;
  background: transparent;
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.repo__name {
  font-size: 13px;
  font-weight: 600;
  color: var(--ht-text-1);
  overflow-wrap: anywhere;
}

.repo__meta {
  font-size: 11.5px;
  color: var(--ht-text-3);
}

.repo__error {
  font-size: 11.5px;
  color: var(--ht-danger);
  overflow-wrap: anywhere;
}

.repo__toggle {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 0 12px 9px;
  font-size: 11.5px;
  color: var(--ht-text-2);
  cursor: pointer;
}

.repo__remove {
  position: absolute;
  top: 8px;
  right: 8px;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 6px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--ht-text-3);
  font: inherit;
  font-size: 11px;
  cursor: pointer;
}

.repo__remove:hover,
.repo__remove.is-armed {
  color: var(--ht-danger);
  background: rgba(220, 68, 68, 0.08);
}

.repo__remove-icon {
  width: 13px;
  height: 13px;
}

.repos__note {
  margin: 2px 0 0;
  font-size: 11.5px;
  line-height: 1.6;
  color: var(--ht-text-3);
}

/* —— 筛选与列表 —— */
.filters {
  display: flex;
  gap: 8px;
  margin-bottom: 12px;
}

.chip {
  padding: 5px 14px;
  border: 1px solid var(--ht-line);
  border-radius: 999px;
  background: var(--ht-surface);
  color: var(--ht-text-2);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}

.chip.is-active {
  border-color: transparent;
  background: var(--ht-primary);
  color: #fff;
}

.list {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.list__head {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 0 2px 8px;
}

.list__head-icon {
  width: 14px;
  height: 14px;
  color: var(--ht-text-3);
}

.list__head-name {
  font-size: 12.5px;
  font-weight: 600;
  color: var(--ht-text-2);
}

.list__head-count {
  margin-left: auto;
  font-size: 11.5px;
  color: var(--ht-text-3);
}

.mr {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 10px 12px;
  border: 1px solid var(--ht-line);
  border-radius: 10px;
  background: var(--ht-surface);
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.mr + .mr {
  margin-top: 6px;
}

.mr:hover {
  border-color: var(--ht-line-strong);
  background: var(--ht-surface-2);
}

.mr.is-open .mr__title {
  color: var(--ht-text-1);
}

.mr__title {
  flex: 1;
  min-width: 0;
  font-size: 13px;
  color: var(--ht-text-1);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.mr__meta {
  flex-shrink: 0;
  font-size: 11.5px;
  color: var(--ht-text-3);
}

/* —— 空态 —— */
.empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  padding: 34px 0;
  color: var(--ht-text-3);
  font-size: 13px;
  text-align: center;
}

.empty p {
  margin: 2px 0;
}

.empty__hint {
  font-size: 12px;
  opacity: 0.85;
}

.empty__icon {
  width: 26px;
  height: 26px;
  opacity: 0.5;
}

.page-foot {
  margin: 16px 2px 0;
  font-size: 11.5px;
  color: var(--ht-text-3);
}

.link {
  border: none;
  background: none;
  padding: 0;
  font: inherit;
  font-size: inherit;
  color: var(--ht-primary);
  cursor: pointer;
}

.link:hover {
  text-decoration: underline;
}

.num {
  font-variant-numeric: tabular-nums;
}

.mono {
  font-family: var(--ht-mono, ui-monospace, monospace);
}
</style>
