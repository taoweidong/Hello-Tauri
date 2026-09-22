<script setup lang="ts">
import { computed } from 'vue'
import { useRouter } from 'vue-router'
import { Coin, DataLine, Refresh, TrendCharts } from '@element-plus/icons-vue'

import { platform } from '@/api'
import { useAppStore } from '@/stores/app'
import { useTableStore } from '@/stores/table'

const router = useRouter()
const appStore = useAppStore()
const tableStore = useTableStore()

const cards = computed(() => [
  { label: '数据总数', value: tableStore.stats.total, suffix: '条', icon: DataLine, type: 'primary' },
  { label: '启用中', value: tableStore.stats.active, suffix: '条', icon: TrendCharts, type: 'success' },
  { label: '已停用', value: tableStore.stats.inactive, suffix: '条', icon: DataLine, type: 'warning' },
  {
    label: '金额合计',
    value: tableStore.stats.amount.toLocaleString('zh-CN'),
    suffix: '元',
    icon: Coin,
    type: 'danger',
  },
])

const statusText: Record<string, string> = { active: '启用', inactive: '停用' }

function goTable() {
  void router.push('/table')
}
</script>

<template>
  <div class="page">
    <el-row :gutter="16">
      <el-col v-for="card in cards" :key="card.label" :xs="24" :sm="12" :md="6">
        <el-card class="stat-card" shadow="hover">
          <div class="stat-card__body">
            <div class="stat-card__icon" :class="`stat-card__icon--${card.type}`">
              <el-icon :size="22"><component :is="card.icon" /></el-icon>
            </div>
            <div>
              <div class="stat-card__label">{{ card.label }}</div>
              <div class="stat-card__value">
                {{ card.value }}
                <span class="stat-card__suffix">{{ card.suffix }}</span>
              </div>
            </div>
          </div>
        </el-card>
      </el-col>
    </el-row>

    <el-row :gutter="16" class="dashboard__row">
      <el-col :xs="24" :md="16">
        <el-card shadow="never">
          <template #header>
            <div class="card-header">
              <span>最近新增</span>
              <el-button text type="primary" @click="goTable">进入数据管理</el-button>
            </div>
          </template>
          <el-table :data="tableStore.recent" size="default" stripe>
            <el-table-column prop="id" label="编号" width="80" />
            <el-table-column prop="name" label="名称" min-width="160" show-overflow-tooltip />
            <el-table-column prop="category" label="分类" width="120" />
            <el-table-column prop="owner" label="负责人" width="100" />
            <el-table-column label="状态" width="90">
              <template #default="{ row }">
                <el-tag size="small" :type="row.status === 'active' ? 'success' : 'info'">
                  {{ statusText[row.status] }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column prop="createdAt" label="创建日期" width="120" />
          </el-table>
        </el-card>
      </el-col>

      <el-col :xs="24" :md="8">
        <el-card shadow="never" class="dashboard__info">
          <template #header>
            <div class="card-header">
              <span>运行信息</span>
              <el-button text :icon="Refresh" @click="appStore.load()" />
            </div>
          </template>
          <el-descriptions :column="1" border size="small">
            <el-descriptions-item label="运行模式">
              {{ platform === 'tauri' ? 'Tauri 桌面' : 'Web 浏览器' }}
            </el-descriptions-item>
            <el-descriptions-item label="应用版本">
              {{ appStore.info?.version ?? '-' }}
            </el-descriptions-item>
            <el-descriptions-item label="Tauri 版本">
              {{ appStore.info?.tauriVersion ?? '-' }}
            </el-descriptions-item>
            <el-descriptions-item label="系统 / 架构">
              {{ appStore.info ? `${appStore.info.platform} / ${appStore.info.arch}` : '-' }}
            </el-descriptions-item>
            <el-descriptions-item label="配置文件">
              <span class="dashboard__path">{{ appStore.info?.configPath ?? '-' }}</span>
            </el-descriptions-item>
          </el-descriptions>
          <el-alert
            class="dashboard__tip"
            type="info"
            :closable="false"
            show-icon
            title="所有业务逻辑均由 TypeScript 实现，Rust 仅负责窗口与配置读写桥接。"
          />
        </el-card>
      </el-col>
    </el-row>
  </div>
</template>

<style scoped>
.stat-card__body {
  display: flex;
  align-items: center;
  gap: 14px;
}

.stat-card__icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 46px;
  height: 46px;
  border-radius: 10px;
}

.stat-card__icon--primary {
  background-color: var(--el-color-primary-light-9);
  color: var(--el-color-primary);
}

.stat-card__icon--success {
  background-color: var(--el-color-success-light-9);
  color: var(--el-color-success);
}

.stat-card__icon--warning {
  background-color: var(--el-color-warning-light-9);
  color: var(--el-color-warning);
}

.stat-card__icon--danger {
  background-color: var(--el-color-danger-light-9);
  color: var(--el-color-danger);
}

.stat-card__label {
  font-size: 13px;
  color: var(--el-text-color-secondary);
}

.stat-card__value {
  margin-top: 6px;
  font-size: 22px;
  font-weight: 600;
  line-height: 1;
  color: var(--el-text-color-primary);
}

.stat-card__suffix {
  margin-left: 4px;
  font-size: 12px;
  font-weight: 400;
  color: var(--el-text-color-secondary);
}

.dashboard__row {
  margin-top: 16px;
}

.dashboard__info {
  height: 100%;
}

.dashboard__path {
  word-break: break-all;
  font-family: Consolas, Monaco, monospace;
  font-size: 12px;
}

.dashboard__tip {
  margin-top: 12px;
}

.card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
</style>
