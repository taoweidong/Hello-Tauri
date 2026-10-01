<script setup lang="ts">
/**
 * 环境检测 —— 主视图。
 *
 * 检测项清单由 store 从 `infra/envcheck` 注册表装配（当前 welink-cli 一项，
 * 后续新 CLI 在注册表里追加即可，本页零改动）。页面自身只做三件事：
 *  1. 进入页面时若「从未检测/中途取消」则自动跑一轮（已有完整结果则不重复跑）；
 *  2. 渐进呈现：每项完成就地上屏，不等最慢项；
 *  3. 离开页面（keep-alive 失活）时取消未决结果回填 —— **主线程从不等待子进程**，
 *     检测全程走异步 Bridge（Rust 侧线程池执行），单项硬超时 16s 兜底，
 *     任何情况下都不会把本页或其他页面卡住。
 */
import { onActivated, onDeactivated } from 'vue'
import { useEnvCheckStore, type EnvCheckOverall, type EnvCheckRunStatus } from '@/stores/envcheck'
import { AppIcon, type IconName } from '@/components/icons'

const store = useEnvCheckStore()

type TagType = 'success' | 'warning' | 'danger' | 'info'
/** el-alert 的 type 取值与 el-tag 不同（error 而非 danger），分开声明 */
type AlertType = 'success' | 'warning' | 'info' | 'error'

const STATUS_META: Record<EnvCheckRunStatus, { label: string; tag: TagType }> = {
  idle: { label: '未检测', tag: 'info' },
  running: { label: '检测中', tag: 'info' },
  ok: { label: '正常', tag: 'success' },
  warn: { label: '告警', tag: 'warning' },
  fail: { label: '异常', tag: 'danger' },
  timeout: { label: '超时', tag: 'danger' },
}

const OVERALL_META: Record<EnvCheckOverall, { type: AlertType; title: string } | null> = {
  idle: null,
  running: { type: 'info', title: '检测进行中 —— 可先去其他页面，结果完成后会就地刷新' },
  partial: { type: 'warning', title: '部分项目未完成检测（可能被取消），可点击「重新检测」补齐' },
  pass: { type: 'success', title: '全部依赖环境正常' },
  warn: { type: 'warning', title: '检测完成，存在告警项 —— 建议查看步骤详情' },
  fail: { type: 'error', title: '检测未通过 —— 存在异常项，请按步骤详情排查' },
}

/** 步骤行图标：ok 勾 / warn 三角 / fail 叉 / timeout 时钟 */
function stepIcon(status: EnvCheckRunStatus): IconName {
  switch (status) {
    case 'ok':
      return 'check'
    case 'warn':
      return 'alert'
    case 'fail':
      return 'x'
    case 'timeout':
      return 'clock'
    default:
      return 'clock'
  }
}

function onRunAll() {
  void store.runAll()
}

function onRunOne(id: string) {
  void store.runOne(id)
}

/** 首次进入或上次被取消（partial）时自动补一轮；已有完整结果则保留展示 */
onActivated(() => {
  if (store.overall === 'idle' || store.overall === 'partial') void store.runAll()
})

/** keep-alive 失活：未决结果作废（代次守卫），避免用户在别处时状态被迟到结果改写 */
onDeactivated(() => {
  store.cancelPending()
})
</script>

<template>
  <div class="page envcheck">
    <div class="page-title">
      <h1>环境检测</h1>
      <span class="caption">CLI 依赖环境检测 · 超时保护 · 不阻塞界面</span>
      <span class="spacer" />
      <el-tag :type="store.mode === 'cli' ? 'success' : 'warning'" size="small" effect="plain" round>
        {{ store.mode === 'cli' ? '真实检测' : '模拟检测' }}
      </el-tag>
      <el-button v-if="store.running" size="small" @click="store.cancelPending()">取消</el-button>
      <el-button type="primary" size="small" :loading="store.running" @click="onRunAll">
        {{ store.running ? '检测中…' : store.items.some((item) => item.status !== 'idle') ? '重新检测' : '开始检测' }}
      </el-button>
    </div>

    <el-alert
      v-if="store.mode === 'mock'"
      type="info"
      show-icon
      :closable="false"
      title="浏览器调试模式：以下为模拟检测结果"
      description="桌面模式（exe）下将真实执行 welink-cli 子命令进行检测。"
    />

    <el-alert
      v-if="OVERALL_META[store.overall]"
      :type="OVERALL_META[store.overall]!.type"
      show-icon
      :closable="false"
      :title="OVERALL_META[store.overall]!.title"
    >
      <template #default>
        <span v-if="store.lastRunAt">最近检测：{{ store.lastRunAt }}</span>
      </template>
    </el-alert>

    <section v-for="item in store.items" :key="item.id" class="ht-card envcheck__item">
      <header class="envcheck__head">
        <span class="envcheck__dot" :class="`is-${item.status}`" />
        <div class="envcheck__title">
          <span class="envcheck__name">{{ item.name }}</span>
          <span class="envcheck__desc">{{ item.description }}</span>
        </div>
        <span class="spacer" />
        <span v-if="item.durationMs !== null" class="envcheck__dur">耗时 {{ item.durationMs }}ms</span>
        <el-tag size="small" :type="STATUS_META[item.status].tag" effect="light">
          {{ STATUS_META[item.status].label }}
        </el-tag>
        <el-button size="small" text :disabled="store.running" @click="onRunOne(item.id)">重测</el-button>
      </header>

      <div class="envcheck__body">
        <p class="envcheck__summary" :class="`is-${item.status}`">
          {{ item.summary || '尚未检测。点击「开始检测」或「重测」运行本项目。' }}
        </p>

        <ul v-if="item.steps.length" class="envcheck__steps">
          <li v-for="step in item.steps" :key="step.name" class="envcheck__step">
            <AppIcon :name="stepIcon(step.status)" class="envcheck__step-icon" :class="`is-${step.status}`" />
            <span class="envcheck__step-name">{{ step.name }}</span>
            <span class="envcheck__step-summary" :class="`is-${step.status}`">{{ step.summary }}</span>
            <span class="envcheck__step-dur">{{ step.durationMs }}ms</span>
          </li>
        </ul>

        <pre v-if="item.details" class="envcheck__details">{{ item.details }}</pre>
      </div>
    </section>
  </div>
</template>

<style scoped>
.envcheck .spacer {
  flex: 1;
}

.envcheck__item + .envcheck__item {
  margin-top: 0;
}

.envcheck__head {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 16px;
  border-bottom: 1px solid var(--ht-line);
}

.envcheck__dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--el-color-info);
  flex: none;
}

.envcheck__dot.is-ok {
  background: var(--el-color-success);
}

.envcheck__dot.is-warn {
  background: var(--el-color-warning);
}

.envcheck__dot.is-fail,
.envcheck__dot.is-timeout {
  background: var(--el-color-danger);
}

.envcheck__dot.is-running {
  background: var(--el-color-primary);
  animation: envcheck-pulse 1.2s ease-in-out infinite;
}

@keyframes envcheck-pulse {
  50% {
    opacity: 0.35;
  }
}

.envcheck__title {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.envcheck__name {
  font-size: 13.5px;
  font-weight: 600;
  color: var(--ht-text-1);
}

.envcheck__desc {
  font-size: 11.5px;
  color: var(--ht-text-3);
}

.envcheck__dur {
  font-size: 11.5px;
  color: var(--ht-text-3);
  white-space: nowrap;
}

.envcheck__body {
  padding: 12px 16px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.envcheck__summary {
  margin: 0;
  font-size: 12.5px;
  color: var(--ht-text-2);
}

.envcheck__summary.is-fail,
.envcheck__summary.is-timeout {
  color: var(--el-color-danger);
}

.envcheck__summary.is-warn {
  color: var(--el-color-warning);
}

.envcheck__steps {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.envcheck__step {
  display: flex;
  align-items: baseline;
  gap: 8px;
  font-size: 12px;
  padding: 6px 10px;
  background: var(--ht-surface-2);
  border-radius: var(--ht-radius-sm, 6px);
}

.envcheck__step-icon {
  flex: none;
  align-self: center;
}

.envcheck__step-icon.is-ok {
  color: var(--el-color-success);
}

.envcheck__step-icon.is-warn {
  color: var(--el-color-warning);
}

.envcheck__step-icon.is-fail {
  color: var(--el-color-danger);
}

.envcheck__step-icon.is-timeout {
  color: var(--el-color-danger);
}

.envcheck__step-name {
  font-weight: 600;
  color: var(--ht-text-1);
  flex: none;
}

.envcheck__step-summary {
  flex: 1;
  min-width: 0;
  color: var(--ht-text-2);
  word-break: break-all;
}

.envcheck__step-summary.is-fail,
.envcheck__step-summary.is-timeout {
  color: var(--el-color-danger);
}

.envcheck__step-summary.is-warn {
  color: var(--el-color-warning);
}

.envcheck__step-dur {
  flex: none;
  font-size: 11px;
  color: var(--ht-text-3);
  font-variant-numeric: tabular-nums;
}

.envcheck__details {
  margin: 0;
  padding: 10px 12px;
  font-size: 11.5px;
  line-height: 1.6;
  color: var(--ht-text-2);
  background: var(--ht-surface-2);
  border: 1px dashed var(--ht-line);
  border-radius: var(--ht-radius-sm, 6px);
  white-space: pre-wrap;
  word-break: break-all;
}
</style>
