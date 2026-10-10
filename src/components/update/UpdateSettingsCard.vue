<script setup lang="ts">
/**
 * Settings 页「软件更新」卡片（design-auto-update §11.5，U-G/U-M）。
 *
 * 与其他配置卡同一立场：本卡片 = 配置编辑（随「保存配置」持久化）+ 运行时状态
 * 呈现与动作入口（检查/安装/扫描摆渡）。更新能力默认关闭 —— 开关本身就是
 * 「运行时零外部请求」唯一例外的闸门，未启用时全卡只读。
 *
 * 失败呈现口径（§4.3）：失败不弹窗打断，状态行与告警条呈现原因；probe 失败
 * （exe 目录不可写）时提示 staging 保留路径，用户可从数据目录手动拷贝。
 */
import { computed, ref, watch } from 'vue'
import { IconRefresh, IconDownload, IconFolder } from '@/components/icons'

import { platform } from '@/api'
import { useAppStore } from '@/stores/app'
import { useUpdateStore } from '@/stores/update'
import { normalizeUpdateSettings, validateEndpoint, type UpdateSettings } from '@/types/update'

const props = defineProps<{ modelValue: Partial<UpdateSettings> }>()
const emit = defineEmits<{
  (e: 'update:modelValue', value: Partial<UpdateSettings>): void
}>()

const appStore = useAppStore()
const updateStore = useUpdateStore()

const draft = ref<UpdateSettings>(normalizeUpdateSettings(props.modelValue))

/** 与 CodehubSettingsCard 同款防抖 push：app store 深度监听并自动落盘，逐键 push 会逐键写盘 */
let lastPushedJson = ''
let pushTimer: ReturnType<typeof setTimeout> | null = null

watch(
  () => props.modelValue,
  (value) => {
    const next = normalizeUpdateSettings(value)
    if (JSON.stringify(next) === lastPushedJson) return
    if (JSON.stringify(next) !== JSON.stringify(draft.value)) draft.value = next
  },
  { deep: true },
)

watch(draft, push, { deep: true })

function push() {
  if (pushTimer) clearTimeout(pushTimer)
  pushTimer = setTimeout(flushPush, 300)
}

function flushPush() {
  pushTimer = null
  const normalized = normalizeUpdateSettings(draft.value)
  lastPushedJson = JSON.stringify(normalized)
  emit('update:modelValue', normalized)
}

/** 端点草稿的即时校验（不拦保存——更新是低风险只读拉取，但给出可见提示） */
const endpointProblem = computed(() =>
  draft.value.enabled && draft.value.endpoint.trim() ? validateEndpoint(draft.value.endpoint) : null,
)

// —— 运行时状态呈现（§4.3 状态机 → 文案）——

const status = computed(() => updateStore.status)

const stateText = computed(() => {
  switch (status.value.state) {
    case 'idle':
      return '尚未检查'
    case 'checking':
      return '正在检查更新…'
    case 'up-to-date':
      return '已是最新版本'
    case 'available':
      return `发现新版本 v${status.value.latest?.version ?? '?'}`
    case 'downloading':
      return '正在下载新版本…'
    case 'verifying':
      return '正在校验完整性…'
    case 'ready':
      return '新版本已就绪，可安装'
    case 'applying':
      return '正在安装（应用即将重启）…'
    case 'failed':
      return '更新失败'
    default:
      return status.value.state
  }
})

const stateTone = computed<'info' | 'success' | 'warning' | 'danger' | 'primary'>(() => {
  switch (status.value.state) {
    case 'up-to-date':
    case 'ready':
      return 'success'
    case 'available':
      return 'warning'
    case 'failed':
      return 'danger'
    case 'checking':
    case 'downloading':
    case 'verifying':
    case 'applying':
      return 'primary'
    default:
      return 'info'
  }
})

/** 下载进度（total 缺失时显示已接收字节数——U-6 降级语义） */
const progressPercent = computed(() => {
  const progress = status.value.progress
  if (!progress?.total) return null
  return Math.min(100, Math.round((progress.received / progress.total) * 100))
})

function fmtBytes(n: number): string {
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

// —— 动作 ——

async function checkNow() {
  await updateStore.checkNow()
}

async function install() {
  await updateStore.install()
}

async function scanInbox() {
  await updateStore.scanInbox()
}

const canInstall = computed(
  () => ['available', 'ready', 'failed'].includes(status.value.state) && !updateStore.busy,
)
</script>

<template>
  <section class="ht-card upd">
    <header class="ht-card__head">
      <span>软件更新</span>
      <span class="spacer" />
      <el-tag size="small" effect="plain" round>
        {{ draft.enabled ? (draft.mode === 'auto' ? '自动安装' : '仅提示') : '未启用' }}
      </el-tag>
    </header>

    <div class="upd__body">
      <el-form :model="draft" label-width="120px" class="upd__form" @submit.prevent>
        <el-form-item label="自动更新">
          <el-switch v-model="draft.enabled" />
          <span class="upd__hint">默认关闭；启用后仅访问下方内网更新源，无任何遥测</span>
        </el-form-item>

        <el-form-item label="更新服务器">
          <el-input
            v-model="draft.endpoint"
            :disabled="!draft.enabled"
            placeholder="http://10.0.0.8/update/hello-tauri/latest.json"
            spellcheck="false"
          />
        </el-form-item>
        <p v-if="endpointProblem" class="upd__problem">{{ endpointProblem }}</p>

        <el-form-item label="更新模式">
          <el-radio-group v-model="draft.mode" :disabled="!draft.enabled">
            <el-radio value="notify">发现新版本时提示，人工确认安装</el-radio>
            <el-radio value="auto">自动下载并安装（安装时重启应用）</el-radio>
          </el-radio-group>
        </el-form-item>

        <el-form-item label="检查间隔">
          <el-input-number v-model="draft.checkIntervalHours" :min="1" :max="168" :disabled="!draft.enabled" />
          <span class="upd__hint">小时（启动 10 秒后检查一次，此后按间隔自动检查）</span>
        </el-form-item>
      </el-form>

      <div class="hairline" />

      <!-- 运行时状态区 -->
      <div class="upd__status">
        <div class="upd__state">
          <span>当前状态</span>
          <el-tag :type="stateTone" size="small" effect="light" round>{{ stateText }}</el-tag>
        </div>

        <p v-if="status.latest" class="upd__notes">
          新版本 v{{ status.latest.version }}
          <span v-if="appStore.info" class="num">（当前 v{{ appStore.info.version }}）</span>
          <template v-if="status.latest.notes">
            <br />
            {{ status.latest.notes }}
          </template>
        </p>

        <el-progress
          v-if="status.state === 'downloading' && status.progress"
          :percentage="progressPercent ?? 100"
          :indeterminate="progressPercent === null"
          :stroke-width="8"
          :format="
            () =>
              progressPercent !== null
                ? `${progressPercent}%`
                : `已接收 ${fmtBytes(status.progress?.received ?? 0)}`
          "
        />

        <el-alert
          v-if="status.state === 'failed' && status.error"
          type="error"
          :closable="false"
          show-icon
          title="更新失败"
          :description="status.error.reason"
        />
        <p v-if="status.state === 'failed' && status.error?.step === 'probe'" class="upd__problem">
          新版本文件保留在数据目录 update\staging\ 下，可在数据目录打开后手动拷贝到程序目录替换。
        </p>

        <div class="upd__actions">
          <el-button
            size="small"
            :icon="IconRefresh"
            :loading="status.state === 'checking'"
            :disabled="updateStore.busy"
            @click="checkNow"
          >
            检查更新
          </el-button>
          <el-button
            size="small"
            type="primary"
            :icon="IconDownload"
            :disabled="!canInstall"
            :loading="status.state === 'downloading' || status.state === 'applying'"
            @click="install"
          >
            {{ status.state === 'ready' ? '立即安装' : '下载并安装' }}
          </el-button>
          <el-button
            v-if="platform === 'tauri'"
            size="small"
            :icon="IconFolder"
            :disabled="updateStore.busy"
            @click="scanInbox"
          >
            扫描摆渡目录
          </el-button>
        </div>
        <p class="upd__meta">
          当前版本 <span class="num">v{{ appStore.info?.version ?? '-' }}</span>
          <template v-if="appStore.info?.tauriVersion"> · Tauri {{ appStore.info.tauriVersion }}</template>
          <span class="upd__meta-dim">（版本与构建信息见「关于」页）</span>
        </p>
      </div>
    </div>
  </section>
</template>

<style scoped>
.upd__body {
  padding: 16px 16px 14px;
}

.upd__form :deep(.el-form-item) {
  margin-bottom: 14px;
}

.upd__hint {
  margin-left: 12px;
  font-size: 12px;
  color: var(--ht-text-3);
}

.upd__problem {
  margin: -6px 0 12px 120px;
  font-size: 12px;
  color: var(--ht-warn);
  line-height: 1.6;
}

.hairline {
  margin: 2px 0 12px;
}

.upd__status {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.upd__state {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 13px;
  color: var(--ht-text-2);
}

.upd__notes {
  margin: 0;
  padding: 10px 12px;
  border: 1px solid var(--ht-line);
  border-radius: var(--ht-radius-sm);
  background: var(--ht-surface-2);
  font-size: 12.5px;
  line-height: 1.7;
  color: var(--ht-text-1);
  white-space: pre-line;
  overflow-wrap: anywhere;
}

.upd__actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

.upd__meta {
  margin: 0;
  font-size: 12px;
  color: var(--ht-text-3);
}

.upd__meta-dim {
  opacity: 0.8;
}

.spacer {
  flex: 1;
}
</style>
