<script setup lang="ts">
import { computed, reactive, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { IconCheck, IconDownload, IconRestore, IconFolder, IconAlert } from '@/components/icons'

import { bridge, platform } from '@/api'
import { useAppStore } from '@/stores/app'
import type { AppSettings } from '@/types'

const appStore = useAppStore()

const form = reactive<AppSettings>({ ...appStore.settings })

watch(
  () => appStore.settings,
  (value) => Object.assign(form, value),
  { deep: true },
)

const routeOptions = [
  { label: '概览', value: '/' },
  { label: '数据管理', value: '/table' },
  { label: '配置', value: '/settings' },
  { label: '关于', value: '/about' },
]

const savedText = computed(() =>
  appStore.lastSavedAt ? new Date(appStore.lastSavedAt).toLocaleString('zh-CN') : '尚未保存',
)

const storage = computed(() => appStore.storage)

function apply() {
  appStore.settings = { ...form }
}

async function save() {
  apply()
  const ok = await appStore.save()
  if (ok) {
    ElMessage({ message: '配置已保存', type: 'success' })
  } else {
    ElMessage.error('保存失败，请查看日志')
  }
}

async function restore() {
  const confirmed = await ElMessageBox.confirm('确认恢复默认配置？', '恢复默认', {
    type: 'warning',
    confirmButtonText: '恢复',
    cancelButtonText: '取消',
  }).catch(() => false)
  if (confirmed === false) return
  appStore.reset()
  Object.assign(form, appStore.settings)
  ElMessage({ message: '已恢复默认配置', type: 'success' })
}

async function openDir() {
  try {
    await bridge.openStorageDir()
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '打开目录失败')
  }
}
</script>

<template>
  <div class="page">
    <div class="page-title">
      <h1>配置</h1>
      <span class="caption">界面偏好与存储位置</span>
    </div>

    <el-alert
      v-if="appStore.storageWarning"
      type="warning"
      :closable="false"
      show-icon
      title="存储位置已回退"
      :description="appStore.storageWarning"
    />

    <div class="cols">
      <!-- 左：偏好表单 -->
      <section class="ht-card">
        <header class="ht-card__head">界面偏好</header>
        <el-form :model="form" label-width="92px" class="form" @submit.prevent>
          <el-form-item label="主题">
            <el-radio-group v-model="form.theme">
              <el-radio-button value="light">浅色</el-radio-button>
              <el-radio-button value="dark">深色</el-radio-button>
            </el-radio-group>
          </el-form-item>

          <el-form-item label="每页条数">
            <el-select v-model="form.pageSize" class="form__control">
              <el-option v-for="size in [5, 10, 20, 50]" :key="size" :label="`${size} 条/页`" :value="size" />
            </el-select>
          </el-form-item>

          <el-form-item label="默认首页">
            <el-select v-model="form.defaultRoute" class="form__control">
              <el-option v-for="item in routeOptions" :key="item.value" :label="item.label" :value="item.value" />
            </el-select>
          </el-form-item>

          <el-form-item label="自动保存">
            <el-switch v-model="form.autoSave" />
            <span class="form__hint">应用后自动写入本地</span>
          </el-form-item>

          <el-form-item label="折叠侧栏">
            <el-switch v-model="form.sidebarCollapsed" />
            <span class="form__hint">仅影响界面显示</span>
          </el-form-item>

          <div class="hairline" />

          <el-form-item label-width="0" class="form__actions">
            <el-button type="primary" :icon="IconDownload" :loading="appStore.saving" @click="save">保存配置</el-button>
            <el-button :icon="IconCheck" @click="apply">仅应用</el-button>
            <el-button :icon="IconRestore" @click="restore">恢复默认</el-button>
          </el-form-item>
        </el-form>
      </section>

      <!-- 右：存储 -->
      <div class="side">
        <section class="ht-card">
          <header class="ht-card__head">
            <span>数据存储</span>
            <span class="spacer" />
            <el-tag v-if="platform === 'tauri'" size="small" effect="plain" round>本机</el-tag>
            <el-tag v-else size="small" type="info" effect="plain" round>localStorage</el-tag>
          </header>
          <dl class="kv">
            <dt>数据目录</dt>
            <dd class="mono">{{ storage?.root ?? '-' }}</dd>
            <dt>配置文件</dt>
            <dd class="mono">{{ storage?.configFile ?? '-' }}</dd>
            <dt>数据文件</dt>
            <dd class="mono">{{ storage?.tableFile ?? '-' }}</dd>
            <dt>日志目录</dt>
            <dd class="mono">{{ storage?.logsDir ?? '-' }}</dd>
            <dt>最近保存</dt>
            <dd>{{ savedText }}</dd>
          </dl>
          <div class="side__actions">
            <button class="link pressable" :disabled="platform !== 'tauri'" @click="openDir">
              <IconFolder class="link__icon" /> 打开数据目录
            </button>
            <span v-if="platform !== 'tauri'" class="side__dim">浏览器模式不可用</span>
          </div>
        </section>

        <section class="ht-card note">
          <IconAlert class="note__icon" />
          <p>配置、数据与日志都保存在本机目录，断网可用；整个文件夹可直接复制备份。</p>
        </section>
      </div>
    </div>
  </div>
</template>

<style scoped>
.cols {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 320px;
  gap: 14px;
  align-items: start;
}

@media (max-width: 1080px) {
  .cols {
    grid-template-columns: 1fr;
  }
}

.ht-card__head .spacer,
.spacer {
  flex: 1;
}

.form {
  padding: 16px 16px 4px;
}

.form :deep(.el-form-item) {
  margin-bottom: 18px;
}

.form__control {
  width: 200px;
}

.form__hint {
  margin-left: 12px;
  font-size: 12px;
  color: var(--ht-text-3);
}

.form__actions {
  margin-top: 14px;
  margin-bottom: 8px !important;
}

.form__actions :deep(.el-form-item__content) {
  margin-left: 0 !important;
  gap: 8px;
}

.hairline {
  margin: 2px 0 14px;
}

.side {
  display: flex;
  flex-direction: column;
  gap: 14px;
  min-width: 0;
}

.kv {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
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
  font-size: 12px;
  color: var(--ht-text-1);
  text-align: right;
  overflow-wrap: anywhere;
}

.kv > dt:not(:first-of-type),
.kv > dd:not(:first-of-type) {
  border-top: 1px solid var(--ht-line);
}

.side__actions {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 16px 14px;
  border-top: 1px solid var(--ht-line);
}

.link {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  border: 1px solid var(--ht-line);
  background: var(--ht-surface);
  color: var(--ht-text-2);
  padding: 5px 12px;
  border-radius: 7px;
  font: inherit;
  font-size: 12.5px;
  cursor: pointer;
}

.link:hover:not(:disabled) {
  border-color: var(--ht-primary-line);
  color: var(--ht-primary);
  background: var(--ht-primary-soft);
}

.link:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.link__icon {
  width: 14px;
  height: 14px;
}

.side__dim {
  font-size: 11.5px;
  color: var(--ht-text-3);
}

.note {
  display: flex;
  gap: 10px;
  padding: 14px 16px;
  align-items: flex-start;
}

.note__icon {
  width: 15px;
  height: 15px;
  color: var(--ht-warn);
  flex-shrink: 0;
  margin-top: 2px;
}

.note p {
  margin: 0;
  font-size: 12px;
  line-height: 1.7;
  color: var(--ht-text-2);
}
</style>