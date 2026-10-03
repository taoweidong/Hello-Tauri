<script setup lang="ts">
/**
 * Settings 页「CodeHub 连接」配置卡片（personal-workbench）。
 *
 * 与 welink 的 SettingsCard 同一立场：配置（持久化参数）与运行时（同步/刷新）
 * 是两种心智模型 —— 本卡片只管参数与连通性验证，运行时干预入口在检视页。
 *
 * 验证走 codehub store（UI 层不直触 infra）：允许用**表单草稿**先验证再保存；
 * 草稿 token 在输入时即注册进日志遮蔽注册表 —— 从第一次输入起日志就不可能落明文。
 *
 * [CLI-ASSUME] 关联：token 以命令行参数注入（design D6），本页只负责收集与持久化；
 * 白名单提示（主干名必须是 codehub-cli）与宿主侧 cli.rs 的 ALLOWED_STEMS 呼应。
 */
import { computed, onBeforeUnmount, ref, watch } from 'vue'

import { IconCheck } from '@/components/icons'
import { useCodehubStore } from '@/stores/codehub'
import { CODEHUB_MAX_BATCH, normalizeCodeHubSettings, type CodeHubSettings } from '@/types/codehub'
import { registerSecret } from '@/utils/logger'

const props = defineProps<{ modelValue: Partial<CodeHubSettings> }>()
const emit = defineEmits<{
  (e: 'update:modelValue', value: Partial<CodeHubSettings>): void
  /** 保存拦截信号（字段不合法时父级禁用保存按钮） */
  (e: 'update:valid', value: boolean): void
}>()

const codehubStore = useCodehubStore()

/** 归一化后的本地草稿：配置是可手改的 JSON，越界值必须在入口收敛 */
const draft = ref<CodeHubSettings>(normalizeCodeHubSettings(props.modelValue))

/** 最近一次 push 出去的归一化结果（JSON）：父组件回写的同值不再重置草稿（评审 F-2 同款） */
let lastPushedJson = ''
let pushTimer: ReturnType<typeof setTimeout> | null = null

watch(
  () => props.modelValue,
  (value) => {
    const next = normalizeCodeHubSettings(value)
    const nextJson = JSON.stringify(next)
    if (nextJson === lastPushedJson) return
    if (nextJson !== JSON.stringify(draft.value)) draft.value = next
  },
  { deep: true },
)

watch(draft, push, { deep: true })

/** 300ms 防抖：app store 对 settings 深度监听并自动落盘，逐键 push 会造成逐键写盘 */
function push() {
  if (pushTimer) clearTimeout(pushTimer)
  pushTimer = setTimeout(flushPush, 300)
}

function flushPush() {
  pushTimer = null
  const normalized = normalizeCodeHubSettings(draft.value)
  lastPushedJson = JSON.stringify(normalized)
  registerSecret(normalized.token)
  emit('update:modelValue', normalized)
}

onBeforeUnmount(() => {
  if (pushTimer) clearTimeout(pushTimer)
})

/** 选真实 CLI 但路径为空：等价于「每次同步都失败」，拦在保存前（token 允许后补，验证与同步会引导） */
const cliPathMissing = computed(() => draft.value.source === 'cli' && !draft.value.cliPath.trim())
const valid = computed(() => !cliPathMissing.value)
watch(valid, (value) => emit('update:valid', value), { immediate: true })

// ---------------- 连通性验证 ----------------

const verifying = ref(false)
const verifyResult = ref<{ ok: boolean; detail: string } | null>(null)

/** 用「表单当前草稿」验证（不必先保存）：store 侧对未配置直接给引导性失败 */
async function verify() {
  verifying.value = true
  verifyResult.value = null
  try {
    verifyResult.value = await codehubStore.verifyConnection(draft.value)
  } catch (error) {
    verifyResult.value = { ok: false, detail: error instanceof Error ? error.message : String(error) }
  } finally {
    verifying.value = false
  }
}
</script>

<template>
  <section class="ht-card cc">
    <header class="ht-card__head">
      <span>CodeHub 连接</span>
      <span class="spacer" />
      <el-tag size="small" effect="plain" round>
        {{ draft.source === 'mock' ? '模拟数据（打桩）' : '真实 CLI' }}
      </el-tag>
    </header>

    <div class="cc__body">
      <el-alert
        v-if="cliPathMissing"
        class="cc__alert"
        type="error"
        :closable="false"
        show-icon
        title="已选择真实 CLI 但未填写路径，保存被拦截"
        description="请填写 codehub-cli 可执行文件路径，或改回「模拟数据」。"
      />

      <el-form :model="draft" label-width="120px" class="cc__form" @submit.prevent>
        <el-form-item label="数据源">
          <el-radio-group v-model="draft.source">
            <el-radio-button value="mock">模拟数据</el-radio-button>
            <el-radio-button value="cli">真实 CLI</el-radio-button>
          </el-radio-group>
          <span class="cc__hint">打桩先行：真实 CLI 契约核实后无需改本页</span>
        </el-form-item>

        <el-form-item label="CLI 路径">
          <el-input
            v-model="draft.cliPath"
            :disabled="draft.source === 'mock'"
            placeholder="如 D:\tools\codehub-cli.exe"
            class="cc__input"
          />
          <span class="cc__hint">宿主白名单仅放行主干名为 codehub-cli 的程序</span>
        </el-form-item>

        <el-form-item label="访问 token">
          <el-input
            v-model="draft.token"
            type="password"
            show-password
            autocomplete="new-password"
            :disabled="draft.source === 'mock'"
            placeholder="内网 CodeHub 的访问令牌"
            class="cc__input"
          />
          <span class="cc__hint">以命令行参数注入，日志全链路脱敏</span>
        </el-form-item>

        <el-form-item label="自动同步间隔">
          <el-input-number
            v-model="draft.pollIntervalSec"
            :min="0"
            :max="86400"
            :step="60"
            :disabled="draft.source === 'mock'"
          />
          <span class="cc__hint">秒；0 = 仅手动刷新，自动同步最小 60 秒</span>
        </el-form-item>

        <el-form-item label="单批上限">
          <el-input-number
            v-model="draft.pullBatchLimit"
            :min="10"
            :max="CODEHUB_MAX_BATCH"
            :step="50"
            :disabled="draft.source === 'mock'"
          />
          <span class="cc__hint">单仓库单轮最多拉取的 MR 条数（上限 {{ CODEHUB_MAX_BATCH }}，超出部分下一轮再拉）</span>
        </el-form-item>

        <el-form-item label="连通验证">
          <el-button :icon="IconCheck" :loading="verifying" :disabled="draft.source === 'mock'" @click="verify">
            验证连接
          </el-button>
          <span v-if="draft.source === 'mock'" class="cc__hint">模拟数据源恒可用，无需验证</span>
        </el-form-item>
      </el-form>

      <el-alert
        v-if="verifyResult"
        class="cc__alert"
        :type="verifyResult.ok ? 'success' : 'error'"
        :closable="false"
        show-icon
        :title="verifyResult.ok ? 'codehub-cli 可用' : '连接不可用'"
        :description="verifyResult.detail"
      />
    </div>
  </section>
</template>

<style scoped>
.cc__body {
  padding: 16px 16px 4px;
}

.cc__alert {
  margin-bottom: 14px;
}

.cc__form :deep(.el-form-item) {
  margin-bottom: 18px;
}

.cc__input {
  max-width: 360px;
}

.cc__hint {
  margin-left: 12px;
  font-size: 12px;
  color: var(--ht-text-3);
}
</style>
