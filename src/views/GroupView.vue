<script setup lang="ts">
/**
 * 快速建群 —— 主视图（migration v3）。
 *
 * 结构与 WeLink 助手页同款：页面标题 + 三 Tab 主区（快速建群 / 建群模板 /
 * 建群历史）。Tab 懒加载（O4 同理由）：只有激活的 Tab 挂载并发查询。
 *
 * 跨 Tab 联动走 store：建群成功 → `historyVersion` 自增 → 历史 Tab 重载当前页；
 * 「去建模板」按钮 → 切到模板 Tab。视图只做编排呈现，不做业务。
 */
import { onMounted, ref } from 'vue'

import { useGroupStore } from '@/stores/group'
import { platform } from '@/api'
import { normalizeWelinkSettings } from '@/types/welink'
import { useAppStore } from '@/stores/app'
import CreateTab from '@/components/group/CreateTab.vue'
import TemplateTab from '@/components/group/TemplateTab.vue'
// 命名避开 welink 的 HistoryTab：同类名会让 unplugin-vue-components 的
// 全局注册表（components.d.ts）互相覆盖，生成结果随扫描顺序抖动
import GroupHistoryTab from '@/components/group/GroupHistoryTab.vue'

const appStore = useAppStore()
const store = useGroupStore()

type TabKey = 'create' | 'templates' | 'history'

const TABS: Array<{ key: TabKey; label: string; hint: string }> = [
  { key: 'create', label: '快速建群', hint: '选模板或直接填写，确认后调用 welink-cli 建群' },
  { key: 'templates', label: '建群模板', hint: '常用「群名称 + 成员」保存为模板，一键带入' },
  { key: 'history', label: '建群历史', hint: '每次建群的留痕：状态、群 ID、成员清单、错误详情' },
]

const activeTab = ref<TabKey>('create')

/** 数据源徽标：桌面模式选了真实 CLI 才是「真实建群」 */
const sourceLabel = ref('')

/** init 失败时页头给出错误与重试入口 —— 失败后静默空白比失败本身更糟 */
const initFailed = ref(false)

async function runInit() {
  initFailed.value = !(await store.init())
}

onMounted(() => {
  void runInit()
  const real = platform === 'tauri' && normalizeWelinkSettings(appStore.settings.weLink).welinkSource === 'cli'
  sourceLabel.value = real ? 'welink-cli 真实建群' : '模拟数据源'
})

function switchTab(tab: 'templates' | 'history') {
  activeTab.value = tab
}
</script>

<template>
  <div class="page groups">
    <div class="page-title">
      <h1>快速建群</h1>
      <span class="caption">建群模板 · 一键外呼 · 全程留痕</span>
      <span class="spacer" />
      <el-tag :type="sourceLabel.startsWith('welink-cli') ? 'success' : 'warning'" size="small" effect="plain" round>
        {{ sourceLabel }}
      </el-tag>
    </div>

    <el-alert v-if="initFailed" type="error" show-icon :closable="false" title="建群数据初始化失败">
      <template #default>
        <div class="groups__init-retry">
          <span>建群模板与历史暂不可用（数据表初始化或装载失败，详情见日志）。</span>
          <el-button size="small" type="primary" plain @click="runInit">重试</el-button>
        </div>
      </template>
    </el-alert>

    <section class="ht-card tabs">
      <header class="tabs__head">
        <button
          v-for="tab in TABS"
          :key="tab.key"
          class="tabs__btn pressable"
          :class="{ 'is-active': activeTab === tab.key }"
          :title="tab.hint"
          @click="activeTab = tab.key"
        >
          {{ tab.label }}
        </button>
        <span class="spacer" />
        <span class="tabs__hint">{{ TABS.find((item) => item.key === activeTab)?.hint }}</span>
      </header>

      <div class="tabs__body">
        <CreateTab v-if="activeTab === 'create'" @switch-tab="switchTab" />
        <TemplateTab v-else-if="activeTab === 'templates'" />
        <GroupHistoryTab v-else />
      </div>
    </section>
  </div>
</template>

<style scoped>
.groups .spacer {
  flex: 1;
}

.groups__init-retry {
  display: flex;
  align-items: center;
  gap: 10px;
}

.tabs {
  display: flex;
  flex-direction: column;
  min-height: 0;
}

.tabs__head {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--ht-line);
}

.tabs__btn {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  border: none;
  background: transparent;
  color: var(--ht-text-2);
  font: inherit;
  font-size: 13px;
  padding: 6px 12px;
  border-radius: var(--ht-radius-sm);
  cursor: pointer;
}

.tabs__btn:hover {
  color: var(--ht-text-1);
  background: var(--ht-surface-2);
}

.tabs__btn.is-active {
  color: var(--ht-primary);
  background: var(--ht-primary-soft);
  font-weight: 600;
}

.tabs__btn:focus-visible {
  outline: 2px solid var(--ht-primary);
  outline-offset: -1px;
}

.tabs__hint {
  font-size: 11.5px;
  color: var(--ht-text-3);
  padding-right: 4px;
}

.tabs__body {
  min-height: 420px;
  max-height: calc(100vh - 320px);
  overflow: auto;
  padding: 14px;
}
</style>
