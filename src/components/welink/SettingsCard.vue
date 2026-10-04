<script setup lang="ts">
/**
 * Settings 页「WeLink 助手」配置卡片（设计 §11.6）。
 *
 * 为什么把它从 WeLinkView 里拆出来单独做成设置卡：
 * 配置（持久化参数）与运行时（开关/急停/待审）是两种心智模型。放同一页会出现
 * 「改了参数但没生效」的经典困惑 —— 本卡片每条参数都标 O14 生效时机，
 * 而运行时干预入口在助手页的控制条。
 *
 * 三条校验（都对应可预见的误配置）：
 *  * 选真实 CLI 但路径为空 → 保存拦截（否则每次轮询都报错）；
 *  * 选真实 CLI 但 S2/S3 调到默认 2 倍以上 → 二次确认（放宽防滥发是最危险的一类改动）。
 *
 * agent 块（大模型连接）自 2026-10-04 起由独立的「大模型（Agent）」配置卡
 * （LlmSettingsCard）承载 —— 它是该块的唯一编辑器；本卡 push 时对 agent **透传**
 * 父级当前值，两卡并存不会互相重置草稿（评审 F-2 的双编辑器变体）。
 */
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'

import { IconAlert, IconCheck } from '@/components/icons'
import { bridge } from '@/api'
import { useWelinkStore } from '@/stores/welink'
import { normalizeWelinkSettings, type WelinkSettings } from '@/types/welink'
import SafetySection from './settings/SafetySection.vue'
import { decodeBase64Text } from '@/utils/b64'
import { formatMs, formatSec } from '@/utils/welink-display'

const props = defineProps<{ modelValue: Partial<WelinkSettings> }>()
const emit = defineEmits<{
  (e: 'update:modelValue', value: Partial<WelinkSettings>): void
  /** 保存拦截信号（字段不合法时父级禁用保存按钮） */
  (e: 'update:valid', value: boolean): void
}>()

const welinkStore = useWelinkStore()

/** 归一化后的本地草稿：配置是可手改的 JSON，越界值必须在入口收敛 */
const draft = ref<WelinkSettings>(normalizeWelinkSettings(props.modelValue))
const activeGroup = ref<string[]>(['overview'])

/** 最近一次 push 出去的归一化结果（JSON）：父组件回写的同值不再重置草稿（评审 F-2） */
let lastPushedJson = ''

watch(
  () => props.modelValue,
  (value) => {
    const next = normalizeWelinkSettings(value)
    const nextJson = JSON.stringify(next)
    // 自己 push 出去的 normalize 回环不重置草稿：否则「清空提示词模板」会被
    // normalize 的默认值兜底顶回出厂文案、数字清空被 clamp 钉回默认值——
    // 用户永远无法清空重写，输入中还会丢光标（评审 F-2）。
    // 外部真变更（父级加载配置 / 恢复默认）仍照常同步。
    if (nextJson === lastPushedJson) return
    if (nextJson !== JSON.stringify(draft.value)) draft.value = next
  },
  { deep: true },
)

watch(draft, push, { deep: true })

// 逐键热更新的代价（评审 F-1）：push → applySettings → runtime.reload + 日志落盘，
// 在多行提示词 textarea 里输入一段模板 = 数百次 IPC 写与数百条日志。300ms
// debounce 保住「改完即生效」的体验，把 reload/日志压到停顿后只发生一次。
let pushTimer: ReturnType<typeof setTimeout> | null = null

function push() {
  if (pushTimer) clearTimeout(pushTimer)
  pushTimer = setTimeout(flushPush, 300)
}

function flushPush() {
  pushTimer = null
  const normalized = normalizeWelinkSettings(draft.value)
  // agent 块的唯一编辑器是「大模型配置」卡：这里用父级当前值回填再 normalize ——
  // 若按本卡草稿整块回写，会把它刚 push 的 agent 改动顶回去（双编辑器互踩）
  const agent = normalizeWelinkSettings({ agent: props.modelValue.agent }).agent
  const merged = { ...normalized, agent }
  lastPushedJson = JSON.stringify(merged)
  emit('update:modelValue', merged)
  // 热更新到运行中的编排层（未启动时是空操作）：改完参数不必重启就生效
  welinkStore.applySettings(merged)
}

onBeforeUnmount(() => {
  if (pushTimer) clearTimeout(pushTimer)
})

// ---------------- 校验 ----------------

/** 选真实 CLI 但路径为空：CLI 的等价值是「每次轮询都失败」，必须拦在保存前 */
const cliPathMissing = computed(() => draft.value.welinkSource === 'cli' && !draft.value.cliPath.trim())

const valid = computed(() => !cliPathMissing.value)
watch(valid, (value) => emit('update:valid', value), { immediate: true })

/**
 * 轮询节奏预估（D-6）。
 *
 * 传草稿里的 `pollIntervalSec`（而非已生效配置），这样用户拖动数字时提示会
 * 立刻跟着变 —— 设置页的价值就在于「改之前先看清后果」。
 */
const plan = computed(() => welinkStore.pollPlan(draft.value.pollIntervalSec))

/** 毫秒的可读格式化（1.5s / 300ms）—— 统一实现见 `utils/welink-display`（T-4） */

/** 秒的可读格式化（保留一位小数即可，避免出现 40.0000001 这种数） */

// ---------------- CLI / Agent 连通性 ----------------

const cliTesting = ref(false)
const testResult = ref<{ ok: boolean; text: string } | null>(null)

/** 试跑 `welink-cli --help`：只验证「能起来 + 有输出」，不校验协议 */
async function testCli() {
  const program = draft.value.cliPath.trim()
  if (!program) {
    ElMessage.warning('请先填写 CLI 路径')
    return
  }
  cliTesting.value = true
  testResult.value = null
  try {
    const result = await bridge.cliRun(program, ['--help'], 8000)
    const stdout = decodeBase64Text(result.stdout).text
    const stderr = decodeBase64Text(result.stderr).text
    const firstLine = (stdout || stderr).split('\n').find((line) => line.trim()) ?? '（无输出）'
    testResult.value = {
      ok: result.exitCode === 0,
      text:
        `退出码 ${result.exitCode ?? '(null)'} · 耗时 ${result.durationMs}ms\n` +
        `首个输出行：${firstLine.trim()}` +
        (result.timedOut ? '\n⚠ 命令超时（8s），基本可判定路径或程序有问题' : ''),
    }
    ElMessage[result.exitCode === 0 ? 'success' : 'warning'](
      result.exitCode === 0 ? 'CLI 可用' : 'CLI 能运行但退出码非 0，请核对子命令',
    )
  } catch (error) {
    testResult.value = {
      ok: false,
      text: error instanceof Error ? error.message : String(error),
    }
    ElMessage.error('CLI 无法启动，请核对路径与文件名（白名单仅允许 welink-cli）')
  } finally {
    cliTesting.value = false
  }
}

const sourceLabel = computed(() => (draft.value.welinkSource === 'mock' ? '模拟数据' : '真实 CLI'))
</script>

<template>
  <section class="ht-card wc">
    <header class="ht-card__head">
      <span>WeLink 助手</span>
      <span class="spacer" />
      <el-tag size="small" :type="draft.enabled ? 'success' : 'info'" effect="plain" round>
        {{ draft.enabled ? '已启用' : '未启用' }}
      </el-tag>
      <el-tag size="small" effect="plain" round>welink={{ sourceLabel }}</el-tag>
      <!-- agent 来源标签随编辑权移交「大模型（Agent）」配置卡（卡头有同款生效值展示） -->
    </header>

    <div class="wc__body">
      <el-alert
        v-if="cliPathMissing"
        class="wc__alert"
        type="error"
        :closable="false"
        show-icon
        title="已选择真实 CLI 但未填写路径，保存被拦截"
        description="保存会导致每次轮询都失败；请填写 welink-cli.exe 路径，或改回「模拟数据」。"
      />

      <el-collapse v-model="activeGroup">
        <!-- ① 总览 -->
        <el-collapse-item name="overview" title="总览">
          <el-form :model="draft" label-width="120px" class="wc__form" @submit.prevent>
            <el-form-item label="助手总开关">
              <el-switch v-model="draft.enabled" />
              <span class="wc__hint">L1：关闭后所有自动外发被拦（消息仍可存档）。运行时也可在助手页控制条切换</span>
            </el-form-item>
            <el-form-item label="消息来源">
              <el-radio-group v-model="draft.welinkSource">
                <el-radio-button value="mock">模拟数据</el-radio-button>
                <el-radio-button value="cli">真实 CLI</el-radio-button>
              </el-radio-group>
              <span class="wc__hint">立即生效</span>
            </el-form-item>
            <el-form-item label="发送模式">
              <el-radio-group v-model="draft.sendMode">
                <el-radio-button value="auto">自动外发</el-radio-button>
                <el-radio-button value="manual">人工确认</el-radio-button>
              </el-radio-group>
              <span class="wc__hint">manual = 草稿生成后停在「待审」，需在回复历史里确认发送；Agent 回复来源的切换在下方「大模型（Agent）」配置卡</span>
            </el-form-item>
          </el-form>
        </el-collapse-item>

        <SafetySection v-model="draft.safety" />

        <!-- ③ 运行参数 -->
        <el-collapse-item name="runtime" title="运行参数">
          <el-form :model="draft" label-width="140px" class="wc__form" @submit.prevent>
            <el-form-item label="轮询间隔">
              <el-input-number v-model="draft.pollIntervalSec" :min="3" :max="60" size="small" />
              <span class="wc__unit">秒</span>
              <span class="wc__hint">下一轮生效（热点会话会自动加密，冷会话自动降频）</span>
              <!-- D-6：如实显示实际周期 —— 用户此前会把「间隔 3s」理解成「3s 拉一轮」，
                   而 20 个会话时每会话 2s 错峰就会让单轮变成 40s+ -->
              <span class="wc__plan" :class="{ 'wc__plan--warn': plan.converged }">
                <template v-if="plan.known">
                  当前 {{ plan.conversationCount }} 个监控会话，每会话错峰 {{ formatMs(plan.staggerMs) }}， 单轮实际约
                  {{ formatSec(plan.periodMs) }}（不含拉取本身耗时）
                  <template v-if="plan.converged"> —— 已按会话数自动收敛错峰，避免「间隔」被错峰淹没 </template>
                </template>
                <template v-else> 单轮实际 = 间隔 + 各会话错峰；监控会话数需打开助手页后可知（此处不猜） </template>
              </span>
            </el-form-item>
            <el-form-item label="单批拉取上限">
              <el-input-number v-model="draft.pullBatchLimit" :min="20" :max="200" size="small" />
              <span class="wc__unit">条</span>
              <span class="wc__hint">下一轮生效；有更多时会连续续批（最多 3 批），余量留给下轮</span>
            </el-form-item>
            <el-form-item label="我的工号">
              <el-input v-model="draft.myUserId" class="wc__control" placeholder="如 10086" />
              <span class="wc__hint">
                立即生效。用于过滤你自己发出的消息；留空会导致自回复循环（S8 会熔断兜底，但助手实际不可用）
              </span>
            </el-form-item>
          </el-form>
        </el-collapse-item>

        <!-- ④ 触发与发送（L2 场景开关） -->
        <el-collapse-item name="trigger" title="触发与发送">
          <el-form :model="draft.trigger" label-width="140px" class="wc__form" @submit.prevent>
            <el-form-item label="群聊 @我 自动回复">
              <el-switch v-model="draft.trigger.groupAtMe" />
              <span v-if="!draft.trigger.groupAtMe" class="wc__warn">关闭后 @你的消息不再自动回复，仅存档</span>
            </el-form-item>
            <el-form-item label="私聊自动回复">
              <el-switch v-model="draft.trigger.privateAutoReply" />
              <span v-if="!draft.trigger.privateAutoReply" class="wc__warn">关闭后私聊消息不再自动回复，仅存档</span>
            </el-form-item>
            <p class="wc__hint wc__hint--block">
              @所有人 不算「@我」（避免被群公告触发）。以上是 L2 场景开关，还受 L3 会话级开关与 SafetyGate 共同约束。
            </p>
          </el-form>
        </el-collapse-item>

        <!-- ⑤ CLI -->
        <el-collapse-item v-if="draft.welinkSource === 'cli'" name="cli" title="CLI 通道">
          <el-form :model="draft" label-width="140px" class="wc__form" @submit.prevent>
            <el-form-item label="程序路径">
              <el-input v-model="draft.cliPath" class="wc__control" placeholder="welink-cli.exe 或完整路径" />
              <el-button size="small" :icon="IconCheck" :loading="cliTesting" @click="testCli">试跑 --help</el-button>
            </el-form-item>
            <p class="wc__hint wc__hint--block">
              仅允许运行白名单内名为 <span class="mono">welink-cli</span> 的程序；输出经 base64 回传， 优先按 UTF-8
              解码，失败回退 GBK（适配中文版 Windows 命令行）。
            </p>
          </el-form>
        </el-collapse-item>

      </el-collapse>

      <!-- 连通性测试结果 -->
      <el-alert
        v-if="testResult"
        class="wc__alert"
        :type="testResult.ok ? 'success' : 'error'"
        :closable="true"
        show-icon
        title="CLI 试跑结果"
        @close="testResult = null"
      >
        <pre class="wc__test-text">{{ testResult.text }}</pre>
      </el-alert>

      <p class="wc__foot">
        <IconAlert class="wc__foot-icon" />
        配置改动会自动热更新到运行中的助手；消息存档、任务与 Agent 留痕都保存在本机数据库，断网可用。
      </p>
    </div>
  </section>
</template>

<style scoped>
.wc {
  display: flex;
  flex-direction: column;
}

.ht-card__head .spacer,
.spacer {
  flex: 1;
}

.wc__body {
  padding: 6px 16px 14px;
}

.wc__alert {
  margin: 10px 0;
}

.wc__form {
  padding-top: 6px;
}

.wc__form :deep(.el-form-item) {
  margin-bottom: 14px;
}

.wc__control {
  width: 260px;
}

.wc__time {
  width: 110px;
  margin-left: 8px;
}

.wc__unit {
  margin-left: 8px;
  font-size: 12px;
  color: var(--ht-text-3);
}

.wc__hint {
  margin-left: 10px;
  font-size: 11.5px;
  color: var(--ht-text-3);
  line-height: 1.7;
}

.wc__hint--block {
  display: block;
  margin: 0 0 6px;
}

/**
 * 实际周期提示（D-6）：与 `.wc__hint` 同色系但**换行独占一行** ——
 * 它是一句「结论」而不是字段注解，跟在输入框后面会被读成下一段说明。
 */
.wc__plan {
  display: block;
  margin: 4px 0 0;
  font-size: 11.5px;
  color: var(--ht-text-3);
  line-height: 1.7;
}

.wc__plan--warn {
  color: var(--ht-primary);
}

.wc__warn {
  margin-left: 10px;
  font-size: 11.5px;
  color: var(--ht-warn);
  font-weight: 600;
}













.wc__test-text {
  margin: 0;
  font-size: 11.5px;
  line-height: 1.7;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.wc__foot {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  margin: 12px 0 0;
  font-size: 11.5px;
  color: var(--ht-text-3);
  line-height: 1.7;
}

.wc__foot-icon {
  width: 14px;
  height: 14px;
  color: var(--ht-warn);
  flex-shrink: 0;
  margin-top: 2px;
}
</style>
