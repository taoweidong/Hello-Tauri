<script setup lang="ts">
import { computed, reactive, watch } from 'vue'
import { Check, Download, FolderOpened, RefreshLeft } from '@element-plus/icons-vue'
import { ElMessage, ElMessageBox } from 'element-plus'

import { bridge, platform } from '@/api'
import { useAppStore } from '@/stores/app'
import type { AppSettings } from '@/types'

const appStore = useAppStore()

const storage = computed(() => appStore.storage)

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

function apply() {
  appStore.settings = { ...form }
}

async function save() {
  apply()
  const ok = await appStore.save()
  if (ok) {
    ElMessage.success('配置已保存')
  } else {
    ElMessage.error('保存失败，请查看控制台日志')
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
  ElMessage.success('已恢复默认配置')
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
    <el-row :gutter="16">
      <el-col :xs="24" :md="14">
        <el-card shadow="never">
          <template #header>
            <div class="card-header">
              <span>应用配置</span>
              <el-tag size="small" type="info" effect="plain">
                {{ platform === 'tauri' ? '写入本地配置文件' : '写入浏览器 localStorage' }}
              </el-tag>
            </div>
          </template>

          <el-form :model="form" label-width="120px" @submit.prevent>
            <el-form-item label="主题">
              <el-radio-group v-model="form.theme">
                <el-radio-button value="light">浅色</el-radio-button>
                <el-radio-button value="dark">深色</el-radio-button>
              </el-radio-group>
            </el-form-item>

            <el-form-item label="每页条数">
              <el-select v-model="form.pageSize" class="settings__control">
                <el-option v-for="size in [5, 10, 20, 50]" :key="size" :label="`${size} 条/页`" :value="size" />
              </el-select>
            </el-form-item>

            <el-form-item label="默认首页">
              <el-select v-model="form.defaultRoute" class="settings__control">
                <el-option v-for="item in routeOptions" :key="item.value" :label="item.label" :value="item.value" />
              </el-select>
            </el-form-item>

            <el-form-item label="自动保存">
              <el-switch v-model="form.autoSave" />
              <span class="settings__hint">点「仅应用」或「保存配置」后自动写入本地</span>
            </el-form-item>

            <el-form-item label="折叠侧边栏">
              <el-switch v-model="form.sidebarCollapsed" />
              <span class="settings__hint">仅影响界面显示</span>
            </el-form-item>

            <el-form-item>
              <el-button type="primary" :icon="Download" :loading="appStore.saving" @click="save">
                保存配置
              </el-button>
              <el-button :icon="Check" @click="apply">仅应用</el-button>
              <el-button :icon="RefreshLeft" @click="restore">恢复默认</el-button>
            </el-form-item>
          </el-form>
        </el-card>
      </el-col>

      <el-col :xs="24" :md="10">
        <el-card shadow="never" class="settings__side">
          <template #header>数据存储</template>
          <el-alert
            v-if="appStore.storageWarning"
            class="settings__alert--top"
            type="warning"
            :closable="false"
            show-icon
            title="存储位置已回退"
            :description="appStore.storageWarning"
          />
          <el-descriptions :column="1" border size="small">
            <el-descriptions-item label="数据目录">
              <span class="settings__path">{{ storage?.root ?? '-' }}</span>
            </el-descriptions-item>
            <el-descriptions-item label="配置文件">
              <span class="settings__path">{{ storage?.configFile ?? '-' }}</span>
            </el-descriptions-item>
            <el-descriptions-item label="数据文件">
              <span class="settings__path">{{ storage?.tableFile ?? '-' }}</span>
            </el-descriptions-item>
            <el-descriptions-item label="日志目录">
              <span class="settings__path">{{ storage?.logsDir ?? '-' }}</span>
            </el-descriptions-item>
            <el-descriptions-item label="最近保存">{{ savedText }}</el-descriptions-item>
          </el-descriptions>
          <div class="settings__actions">
            <el-button
              size="small"
              :icon="FolderOpened"
              :disabled="platform !== 'tauri'"
              @click="openDir"
            >
              打开数据目录
            </el-button>
            <span class="settings__hint">{{ platform === 'tauri' ? '' : '浏览器模式不可用' }}</span>
          </div>
          <el-alert
            class="settings__alert"
            type="info"
            :closable="false"
            show-icon
            title="单文件绿色版"
            description="程序为单个 exe，无需安装任何依赖；配置、日志与数据全部保存在上面这个目录，可直接复制备份。"
          />
        </el-card>
      </el-col>
    </el-row>
  </div>
</template>

<style scoped>
.settings__control {
  width: 200px;
}

.settings__hint {
  margin-left: 12px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.settings__side {
  height: 100%;
}

.settings__path {
  word-break: break-all;
  font-family: Consolas, Monaco, monospace;
  font-size: 12px;
}

.settings__alert {
  margin-top: 12px;
}

.settings__alert--top {
  margin-bottom: 12px;
}

.settings__actions {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 12px;
}

.card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
</style>
