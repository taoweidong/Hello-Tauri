<script setup lang="ts">
import { computed } from 'vue'
import { useRouter } from 'vue-router'
import { IconTable, IconRefresh, IconArrowRight, IconDatabase, IconActivity, IconUser, IconClock } from '@/components/icons'

import { platform } from '@/api'
import { useAppStore } from '@/stores/app'
import { CATEGORIES, useTableStore } from '@/stores/table'

const router = useRouter()
const appStore = useAppStore()
const tableStore = useTableStore()

function fmt(n: number) {
  return n.toLocaleString('zh-CN')
}

/** 分类分布：条数 + 金额占比，供色带条使用 */
const distribution = computed(() => {
  const total = tableStore.rows.length || 1
  return CATEGORIES.map((cat, i) => {
    const rows = tableStore.rows.filter((row) => row.category === cat)
    const amount = rows.reduce((sum, row) => sum + row.amount, 0)
    return { name: cat, count: rows.length, amount, pct: Math.round((rows.length / total) * 100), idx: i }
  }).sort((a, b) => b.count - a.count)
})

const ledger = computed(() => [
  { key: 'total', label: '记录总数', value: fmt(tableStore.stats.total), unit: '条', icon: IconDatabase },
  { key: 'active', label: '启用', value: fmt(tableStore.stats.active), unit: '条', icon: IconActivity, ratio: tableStore.stats.total ? tableStore.stats.active / tableStore.stats.total : 0 },
  { key: 'inactive', label: '停用', value: fmt(tableStore.stats.inactive), unit: '条', icon: IconClock },
  { key: 'amount', label: '金额合计', value: fmt(tableStore.stats.amount), unit: '元', icon: IconTable },
])

const statusText: Record<string, string> = { active: '启用', inactive: '停用' }
const catIndex = (name: string) => Math.max(0, CATEGORIES.indexOf(name))

const infoRows = computed(() => [
  { label: '运行模式', value: platform === 'tauri' ? 'Tauri 桌面' : 'Web 浏览器' },
  { label: '应用版本', value: appStore.info?.version ?? '-' },
  { label: 'Tauri 版本', value: appStore.info?.tauriVersion ?? '-' },
  { label: '系统 / 架构', value: appStore.info ? `${appStore.info.platform} / ${appStore.info.arch}` : '-' },
  { label: '配置文件', value: appStore.info?.configPath ?? '-', mono: true },
])
</script>

<template>
  <div class="page">
    <div class="page-title">
      <h1>概览</h1>
      <span class="caption">数据与运行状态一览</span>
    </div>

    <!-- 指标条：单行 hairline 分隔，不拆成四张浮卡 -->
    <section class="ledger" aria-label="数据摘要">
      <div v-for="item in ledger" :key="item.key" class="ledger__cell">
        <component :is="item.icon" class="ledger__icon" />
        <div class="ledger__meta">
          <span class="ledger__label">{{ item.label }}</span>
          <span class="ledger__value num">
            {{ item.value }}<small>{{ item.unit }}</small>
          </span>
          <span v-if="item.ratio !== undefined" class="ledger__bar" aria-hidden="true">
            <span class="ledger__bar-fill" :style="{ width: Math.round(item.ratio * 100) + '%' }" />
          </span>
        </div>
      </div>
    </section>

    <div class="grid">
      <!-- 左：最近记录 -->
      <section class="ht-card panel">
        <header class="ht-card__head">
          <span>最近记录</span>
          <span class="spacer" />
          <button class="link pressable" @click="router.push('/table')">
            进入数据管理 <IconArrowRight class="link__icon" />
          </button>
        </header>
        <el-table :data="tableStore.recent" size="small" :show-header="true">
          <el-table-column prop="id" label="编号" width="70">
            <template #default="{ row }"><span class="num muted">#{{ row.id }}</span></template>
          </el-table-column>
          <el-table-column prop="name" label="名称" min-width="140" show-overflow-tooltip>
            <template #default="{ row }">
              <span class="dot" :class="`dot--${catIndex(row.category)}`" aria-hidden="true" />
              {{ row.name }}
            </template>
          </el-table-column>
          <el-table-column prop="category" label="分类" width="110">
            <template #default="{ row }"><span class="cell2">{{ row.category }}</span></template>
          </el-table-column>
          <el-table-column prop="owner" label="负责人" width="90">
            <template #default="{ row }">
              <span class="owner"><IconUser class="owner__icon" />{{ row.owner }}</span>
            </template>
          </el-table-column>
          <el-table-column label="状态" width="80">
            <template #default="{ row }">
              <span class="pill" :class="{ 'pill--ok': row.status === 'active' }">{{ statusText[row.status] }}</span>
            </template>
          </el-table-column>
          <el-table-column prop="amount" label="金额" width="110" align="right">
            <template #default="{ row }"><span class="num">{{ fmt(row.amount) }}</span></template>
          </el-table-column>
          <template #empty>
            <div class="empty">
              <IconDatabase class="empty__icon" />
              <p>暂无记录</p>
              <button class="link" @click="router.push('/table')">去添加第一条 <IconArrowRight class="link__icon" /></button>
            </div>
          </template>
        </el-table>
      </section>

      <!-- 右：分类分布 + 运行信息 -->
      <div class="side">
        <section class="ht-card">
          <header class="ht-card__head">分类分布</header>
          <div class="ht-card__body dist">
            <div v-for="item in distribution" :key="item.name" class="dist__row">
              <span class="dot" :class="`dot--${item.idx}`" aria-hidden="true" />
              <span class="dist__name">{{ item.name }}</span>
              <span class="dist__track"><span class="dist__fill" :class="`dot--${item.idx}`" :style="{ width: item.pct + '%' }" /></span>
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
          </dl>
          <p class="foot-note">业务逻辑全部由 TypeScript 实现，Rust 仅桥接窗口与存储。</p>
        </section>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* —— 指标条 —— */
.ledger {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  background: var(--ht-surface);
  border: 1px solid var(--ht-line);
  border-radius: var(--ht-radius);
  overflow: hidden;
}

.ledger__cell {
  display: flex;
  gap: 12px;
  padding: 16px 18px;
}

.ledger__cell + .ledger__cell {
  border-left: 1px solid var(--ht-line);
}

.ledger__icon {
  width: 18px;
  height: 18px;
  color: var(--ht-text-3);
  margin-top: 2px;
  flex-shrink: 0;
}

.ledger__meta {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}

.ledger__label {
  font-size: 12px;
  color: var(--ht-text-3);
}

.ledger__value {
  font-size: 21px;
  font-weight: 600;
  line-height: 1.15;
  color: var(--ht-text-1);
  letter-spacing: -0.01em;
}

.ledger__value small {
  font-size: 12px;
  font-weight: 400;
  color: var(--ht-text-3);
  margin-left: 4px;
}

.ledger__bar {
  display: block;
  height: 3px;
  margin-top: 6px;
  border-radius: 2px;
  background: var(--ht-surface-2);
  overflow: hidden;
}

.ledger__bar-fill {
  display: block;
  height: 100%;
  border-radius: 2px;
  background: var(--ht-primary);
  transition: width 0.4s cubic-bezier(0.22, 0.61, 0.36, 1);
}

@media (max-width: 1080px) {
  .ledger {
    grid-template-columns: repeat(2, 1fr);
  }

  .ledger__cell:nth-child(3) {
    border-left: none;
  }

  .ledger__cell:nth-child(n + 3) {
    border-top: 1px solid var(--ht-line);
  }
}

/* —— 双栏布局 —— */
.grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 300px;
  gap: 14px;
  align-items: start;
}

@media (max-width: 1180px) {
  .grid {
    grid-template-columns: 1fr;
  }
}

.side {
  display: flex;
  flex-direction: column;
  gap: 14px;
  min-width: 0;
}

.panel :deep(.el-table) {
  --el-table-border-color: var(--ht-line);
}

/* —— 表格单元 —— */
.muted {
  color: var(--ht-text-3);
}

.cell2 {
  font-size: 12px;
  color: var(--ht-text-2);
}

.owner {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 12px;
  color: var(--ht-text-2);
}

.owner__icon {
  width: 12px;
  height: 12px;
  color: var(--ht-text-3);
}

.dot {
  margin-right: 7px;
  vertical-align: 1px;
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

.dist__row .dot {
  margin-right: 0;
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

.foot-note {
  margin: 0;
  padding: 10px 16px 14px;
  border-top: 1px solid var(--ht-line);
  font-size: 11.5px;
  line-height: 1.6;
  color: var(--ht-text-3);
}

.empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  padding: 26px 0;
  color: var(--ht-text-3);
  font-size: 13px;
}

.empty p {
  margin: 2px 0 4px;
}

.empty__icon {
  width: 26px;
  height: 26px;
  opacity: 0.5;
}
</style>