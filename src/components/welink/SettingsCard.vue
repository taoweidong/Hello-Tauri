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
 *  * 选内网 Agent 但 baseUrl 为空 → 提示会回退 mock（不拦截，但要说清）；
 *  * S2/S3 调到默认 2 倍以上 → 二次确认（放宽防滥发是最危险的一类改动）。
 */
import { computed, onBeforeUnmount, reactive, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'

import { IconAlert, IconCheck, IconRefresh, IconRestore } from '@/components/icons'
import { bridge } from '@/api'
import { createAgentProbe } from '@/infra/agent'
import { useWelinkStore } from '@/stores/welink'
import {
  applySafetyPreset,
  DEFAULT_PROMPT_TEMPLATE,
  DEFAULT_WELINK_SETTINGS,
  normalizeWelinkSettings,
  PROMPT_PLACEHOLDERS,
  SAFETY_PRESETS,
  type WelinkSettings,
} from '@/types/welink'
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
  lastPushedJson = JSON.stringify(normalized)
  emit('update:modelValue', normalized)
  // 热更新到运行中的编排层（未启动时是空操作）：改完参数不必重启就生效
  welinkStore.applySettings(normalized)
}

onBeforeUnmount(() => {
  if (pushTimer) clearTimeout(pushTimer)
})

// ---------------- 校验 ----------------

/** 选真实 CLI 但路径为空：CLI 的等价值是「每次轮询都失败」，必须拦在保存前 */
const cliPathMissing = computed(() => draft.value.welinkSource === 'cli' && !draft.value.cliPath.trim())
const agentUrlMissing = computed(() => draft.value.agent.agentSource === 'http' && !draft.value.agent.baseUrl.trim())

const valid = computed(() => !cliPathMissing.value)
watch(valid, (value) => emit('update:valid', value), { immediate: true })

/** 模板占位符缺失告警（设计 §11.6：变量缺失 → 保存警告） */
const missingPlaceholders = computed(() =>
  PROMPT_PLACEHOLDERS.filter((token) => !draft.value.agent.promptTemplate.includes(token)),
)

/**
 * 轮询节奏预估（D-6）。
 *
 * 传草稿里的 `pollIntervalSec`（而非已生效配置），这样用户拖动数字时提示会
 * 立刻跟着变 —— 设置页的价值就在于「改之前先看清后果」。
 */
const plan = computed(() => welinkStore.pollPlan(draft.value.pollIntervalSec))

/** 毫秒的可读格式化（1.5s / 300ms）—— 统一实现见 `utils/welink-display`（T-4） */

/** 秒的可读格式化（保留一位小数即可，避免出现 40.0000001 这种数） */

/**
 * 非回环 + 明文 HTTP 告警（S-3）。
 *
 * 为什么只警告不回环：回环地址（127.0.0.1 / localhost / ::1）的流量不出本机，
 * 明文并不构成额外暴露 —— 对一个「内网离线可用」的桌面应用来说，本地模型
 * 走 http://127.0.0.1:8080 是正常用法，把它也标红只会让告警变成噪音。
 * 判据是「**离开本机**且明文」才提示。
 */
const agentUrlInsecure = computed(() => {
  const url = draft.value.agent.baseUrl.trim()
  if (!url || draft.value.agent.agentSource !== 'http') return false
  if (!/^http:\/\//i.test(url)) return false
  const host = url
    .replace(/^https?:\/\//i, '')
    .split(/[/:?#]/)[0]
    .toLowerCase()
  return !['localhost', '127.0.0.1', '[::1]', '::1', '0.0.0.0'].includes(host)
})

// ---------------- O9 预设三档 ----------------

/** 当前档位：与预设值完全一致才算命中，否则显示「自定义」 */
const currentPreset = computed(() => {
  const safety = draft.value.safety
  return (
    SAFETY_PRESETS.find(
      (preset) =>
        preset.values.perConvMinIntervalSec === safety.perConvMinIntervalSec &&
        preset.values.perConvHourlyCap === safety.perConvHourlyCap &&
        preset.values.globalHourlyCap === safety.globalHourlyCap &&
        preset.values.quietHoursEnabled === safety.quietHours.enabled,
    )?.id ?? 'custom'
  )
})

const presetId = computed({
  get: () => currentPreset.value,
  set: (id: string) => {
    const preset = SAFETY_PRESETS.find((item) => item.id === id)
    if (!preset) return
    draft.value.safety = applySafetyPreset(draft.value.safety, preset)
    ElMessage.success(`已套用「${preset.label}」预设，可展开微调`)
  },
})

const presetOptions = computed(() => [
  ...SAFETY_PRESETS.map((preset) => ({ id: preset.id, label: preset.label, description: preset.description })),
  { id: 'custom', label: '自定义', description: '当前参数不匹配任何预设（已手动微调）' },
])

/** 放宽防滥发（超默认 2 倍）需要二次确认 —— 这是最容易造成事故的一类改动 */
const DEFAULT_SAFETY = DEFAULT_WELINK_SETTINGS.safety
async function guardCapChange(field: 'perConvHourlyCap' | 'globalHourlyCap', value: number) {
  const limit = DEFAULT_SAFETY[field] * 2
  if (value <= limit) return true
  const { ElMessageBox } = await import('element-plus')
  const confirmed = await ElMessageBox.confirm(
    `该值（${value}）已超过默认值（${DEFAULT_SAFETY[field]}）的 2 倍。放宽防滥发上限会真实提高「刷屏」风险，确认继续？`,
    '确认放宽配额',
    { type: 'warning', confirmButtonText: '确认放宽', cancelButtonText: '改回去' },
  ).catch(() => false)
  if (confirmed === false) {
    draft.value.safety[field] = DEFAULT_SAFETY[field]
    return false
  }
  return true
}

// ---------------- 拦截图预览（O9 的「预览拦截效果」） ----------------

const preview = reactive({ perConv: 8, global: 12 })

/** 纯前端估算：把当前参数套到一个模拟场景上，直观说明哪条规则先命中 */
const previewResult = computed(() => {
  const safety = draft.value.safety
  const hits: string[] = []
  if (preview.perConv > safety.perConvHourlyCap) hits.push(`S2 单会话小时上限（${safety.perConvHourlyCap}）会先命中`)
  if (preview.global > safety.globalHourlyCap) hits.push(`S3 全局小时上限（${safety.globalHourlyCap}）会先命中`)
  if (safety.perConvMinIntervalSec > 0) {
    hits.push(
      `S1 每条之间至少间隔 ${safety.perConvMinIntervalSec}s，1 分钟内最多 ${Math.floor(60 / safety.perConvMinIntervalSec) || 1} 条`,
    )
  }
  if (safety.quietHours.enabled) hits.push(`S4 静默时段 ${safety.quietHours.from}–${safety.quietHours.to} 期间不外发`)
  if (safety.mergeWindowSec > 0) hits.push(`S5 ${safety.mergeWindowSec}s 内同会话重复内容会合并`)
  return hits
})

// ---------------- CLI / Agent 连通性 ----------------

const cliTesting = ref(false)
const agentTesting = ref(false)
const testResult = ref<{ kind: 'cli' | 'agent'; ok: boolean; text: string } | null>(null)

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
      kind: 'cli',
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
      kind: 'cli',
      ok: false,
      text: error instanceof Error ? error.message : String(error),
    }
    ElMessage.error('CLI 无法启动，请核对路径与文件名（白名单仅允许 welink-cli）')
  } finally {
    cliTesting.value = false
  }
}

/**
 * 连通性测试：发固定探测 prompt，看耗时与返回摘要。
 *
 * 走 `createAgentProbe`（评审 A-1）：共享运行期同一份环境兜底（浏览器强制 mock，
 * 探测结论与真实运行链路一致），但用独立实例——不命中全局缓存、不挂管线
 * onCall 录音钩子，探测请求不污染 R4 留痕语料。
 */
async function testAgent() {
  agentTesting.value = true
  testResult.value = null
  try {
    const settings = draft.value.agent
    const probe = createAgentProbe({ ...settings, timeoutMs: Math.min(settings.timeoutMs, 15_000) })
    const started = Date.now()
    const reply = await probe.complete('连通性测试：请只回复「ok」两个字符。')
    const elapsed = Date.now() - started
    testResult.value = {
      kind: 'agent',
      ok: true,
      text: `耗时 ${elapsed}ms · 返回摘要：${reply.slice(0, 120)}${reply.length > 120 ? '…' : ''}`,
    }
    ElMessage.success('Agent 连通正常')
  } catch (error) {
    testResult.value = {
      kind: 'agent',
      ok: false,
      text: error instanceof Error ? error.message : String(error),
    }
    ElMessage.error('Agent 连通失败，请核对地址与端口')
  } finally {
    agentTesting.value = false
  }
}

// ---------------- 模板操作 ----------------

function restoreTemplate() {
  draft.value.agent.promptTemplate = DEFAULT_PROMPT_TEMPLATE
  ElMessage.success('已恢复内置提示词模板')
}

/** 插入占位符到模板末尾（省得手打 {{ }}） */
function insertPlaceholder(token: string) {
  draft.value.agent.promptTemplate = `${draft.value.agent.promptTemplate}\n${token}`
}

const sourceLabel = computed(() => (draft.value.welinkSource === 'mock' ? '模拟数据' : '真实 CLI'))
const agentLabel = computed(() => (draft.value.agent.agentSource === 'mock' ? '模拟回复' : '内网 HTTP'))
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
      <el-tag size="small" effect="plain" round>agent={{ agentLabel }}</el-tag>
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
      <el-alert
        v-else-if="agentUrlMissing"
        class="wc__alert"
        type="warning"
        :closable="false"
        show-icon
        title="已选择内网 Agent 但 baseUrl 为空"
        description="运行时会自动回退到「模拟回复」，回复内容不是模型生成的。填写地址后重新保存即可生效。"
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
            <el-form-item label="Agent 来源">
              <el-radio-group v-model="draft.agent.agentSource">
                <el-radio-button value="mock">模拟回复</el-radio-button>
                <el-radio-button value="http">内网 HTTP</el-radio-button>
              </el-radio-group>
              <span class="wc__hint">立即生效</span>
            </el-form-item>
            <el-form-item label="发送模式">
              <el-radio-group v-model="draft.sendMode">
                <el-radio-button value="auto">自动外发</el-radio-button>
                <el-radio-button value="manual">人工确认</el-radio-button>
              </el-radio-group>
              <span class="wc__hint">manual = 草稿生成后停在「待审」，需在回复历史里确认发送</span>
            </el-form-item>
          </el-form>
        </el-collapse-item>

        <!-- ② 防滥发（S1–S8） -->
        <el-collapse-item name="safety" title="防滥发（SafetyGate 闸口）">
          <div class="wc__presets">
            <el-radio-group v-model="presetId">
              <el-radio-button
                v-for="preset in presetOptions"
                :key="preset.id"
                :value="preset.id"
                :title="preset.description"
              >
                {{ preset.label }}
              </el-radio-button>
            </el-radio-group>
            <p class="wc__preset-desc">
              {{ presetOptions.find((item) => item.id === presetId)?.description }}
            </p>
          </div>

          <el-form :model="draft.safety" label-width="120px" class="wc__form" @submit.prevent>
            <el-form-item label="S1 最小间隔">
              <el-input-number
                v-model="draft.safety.perConvMinIntervalSec"
                :min="0"
                :max="600"
                :step="1"
                size="small"
              />
              <span class="wc__unit">秒 / 每会话</span>
              <span class="wc__hint">同一会话两次回复的最小间隔，跨重启仍然生效</span>
            </el-form-item>
            <el-form-item label="S2 会话小时上限">
              <el-input-number
                v-model="draft.safety.perConvHourlyCap"
                :min="1"
                :max="500"
                size="small"
                @change="(value: number | undefined) => value && guardCapChange('perConvHourlyCap', value)"
              />
              <span class="wc__unit">条 / 小时</span>
            </el-form-item>
            <el-form-item label="S3 全局小时上限">
              <el-input-number
                v-model="draft.safety.globalHourlyCap"
                :min="1"
                :max="1000"
                size="small"
                @change="(value: number | undefined) => value && guardCapChange('globalHourlyCap', value)"
              />
              <span class="wc__unit">条 / 小时</span>
              <span class="wc__hint">所有会话合计，超出后任务回「待发送」等下一小时</span>
            </el-form-item>
            <el-form-item label="S4 静默时段">
              <el-switch v-model="draft.safety.quietHours.enabled" />
              <el-time-picker
                v-if="draft.safety.quietHours.enabled"
                v-model="draft.safety.quietHours.from"
                format="HH:mm"
                value-format="HH:mm"
                size="small"
                placeholder="开始"
                class="wc__time"
              />
              <span v-if="draft.safety.quietHours.enabled" class="wc__unit">至</span>
              <el-time-picker
                v-if="draft.safety.quietHours.enabled"
                v-model="draft.safety.quietHours.to"
                format="HH:mm"
                value-format="HH:mm"
                size="small"
                placeholder="结束"
                class="wc__time"
              />
            </el-form-item>
            <el-form-item label="S5 合并窗口">
              <el-input-number v-model="draft.safety.mergeWindowSec" :min="0" :max="3600" size="small" />
              <span class="wc__unit">秒</span>
              <span class="wc__hint">窗口内同一会话的重复触发只回一次</span>
            </el-form-item>
            <el-form-item label="S6 草稿长度上限">
              <el-input-number v-model="draft.safety.maxDraftChars" :min="20" :max="4000" size="small" />
              <span class="wc__unit">字符</span>
            </el-form-item>
            <el-form-item label="S7 敏感句式黑名单">
              <div class="wc__patterns">
                <div v-for="(_, index) in draft.safety.blacklistPatterns" :key="index" class="wc__pattern">
                  <el-input v-model="draft.safety.blacklistPatterns[index]" size="small" placeholder="正则表达式" />
                  <el-button size="small" text type="danger" @click="draft.safety.blacklistPatterns.splice(index, 1)"
                    >删除</el-button
                  >
                </div>
                <el-button size="small" text @click="draft.safety.blacklistPatterns.push('')">+ 添加一条</el-button>
                <p class="wc__hint">命中后转「人工待审」而不是丢弃：保留草稿让人判断，避免误伤正常回复</p>
              </div>
            </el-form-item>
            <el-form-item label="S8 熔断">
              <el-input-number v-model="draft.safety.fuseWindowMin" :min="1" :max="1440" size="small" />
              <span class="wc__unit">分钟内同类拦截达</span>
              <el-input-number v-model="draft.safety.fuseThreshold" :min="1" :max="100" size="small" />
              <span class="wc__unit">次 → 暂停该场景</span>
              <span class="wc__hint">熔断后在助手页横幅上人工解除，避免异常内容持续外发</span>
            </el-form-item>
          </el-form>

          <!-- 拦截图预览（O9） -->
          <div class="wc__preview">
            <span class="wc__preview-title">预览拦截效果</span>
            <div class="wc__preview-row">
              <span>某会话 1 小时内触发</span>
              <el-input-number
                v-model="preview.perConv"
                :min="1"
                :max="200"
                size="small"
                controls-position="right"
                class="wc__preview-num"
              />
              <span>条，全局触发</span>
              <el-input-number
                v-model="preview.global"
                :min="1"
                :max="500"
                size="small"
                controls-position="right"
                class="wc__preview-num"
              />
              <span>条</span>
            </div>
            <ul class="wc__preview-list">
              <li v-for="(line, index) in previewResult" :key="index">{{ line }}</li>
            </ul>
          </div>
        </el-collapse-item>

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

        <!-- ⑥ Agent -->
        <el-collapse-item v-if="draft.agent.agentSource === 'http'" name="agent" title="Agent 通道">
          <el-form :model="draft.agent" label-width="140px" class="wc__form" @submit.prevent>
            <el-form-item label="服务地址">
              <el-input v-model="draft.agent.baseUrl" class="wc__control" placeholder="http://10.0.0.5:8080" />
              <!-- S-3：请求体含完整聊天上下文，明文 HTTP 出内网即等于聊天记录裸奔 -->
              <span v-if="agentUrlInsecure" class="wc__warn">
                非回环地址 + 明文 HTTP：提示词（含聊天原文）会以明文离开本机，请确认在内网可信链路上
              </span>
            </el-form-item>
            <el-form-item label="接口路径">
              <el-input v-model="draft.agent.endpoint" class="wc__control" placeholder="/chat" />
            </el-form-item>
            <el-form-item label="超时">
              <el-input-number v-model="draft.agent.timeoutMs" :min="1000" :max="300000" :step="1000" size="small" />
              <span class="wc__unit">毫秒</span>
            </el-form-item>
            <el-form-item label="上下文条数">
              <el-input-number v-model="draft.agent.maxContextMsgs" :min="1" :max="200" size="small" />
              <span class="wc__unit">条</span>
              <span class="wc__hint">取该会话最近 N 条消息拼进提示词（客户端组装）</span>
            </el-form-item>
            <el-form-item label="">
              <el-button size="small" :icon="IconRefresh" :loading="agentTesting" @click="testAgent"
                >连通性测试</el-button
              >
              <span class="wc__hint">发送固定探测提示词，显示耗时与返回摘要</span>
            </el-form-item>
          </el-form>
        </el-collapse-item>

        <!-- ⑦ 提示词模板 -->
        <el-collapse-item name="prompt" title="提示词模板">
          <div class="wc__prompt">
            <div class="wc__prompt-bar">
              <span class="wc__hint">占位符：</span>
              <el-tag
                v-for="token in PROMPT_PLACEHOLDERS"
                :key="token"
                size="small"
                effect="plain"
                class="wc__token pressable"
                @click="insertPlaceholder(token)"
              >
                {{ token }}
              </el-tag>
              <span class="spacer" />
              <el-button size="small" :icon="IconRestore" @click="restoreTemplate">恢复内置模板</el-button>
            </div>
            <el-input v-model="draft.agent.promptTemplate" type="textarea" :rows="14" class="wc__textarea" />
            <el-alert
              v-if="missingPlaceholders.length"
              class="wc__alert"
              type="warning"
              :closable="false"
              show-icon
              :title="`模板缺少占位符：${missingPlaceholders.join('、')}`"
              description="缺少的占位符不会被替换，模型将拿不到对应信息（如对话上下文或待回复消息），回复质量会明显下降。"
            />
            <p class="wc__hint">
              模板每次生成时读取，改完立即对下一条任务生效。提示词里「只输出正文」等约束是防模型输出前后缀噪声的关键。
            </p>
          </div>
        </el-collapse-item>
      </el-collapse>

      <!-- 连通性测试结果 -->
      <el-alert
        v-if="testResult"
        class="wc__alert"
        :type="testResult.ok ? 'success' : 'error'"
        :closable="true"
        show-icon
        :title="testResult.kind === 'cli' ? 'CLI 试跑结果' : 'Agent 连通性结果'"
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

.wc__presets {
  padding: 10px 0 4px;
}

.wc__preset-desc {
  margin: 8px 0 0;
  font-size: 11.5px;
  color: var(--ht-text-3);
}

.wc__patterns {
  display: flex;
  flex-direction: column;
  gap: 6px;
  width: 100%;
  max-width: 560px;
}

.wc__pattern {
  display: flex;
  align-items: center;
  gap: 6px;
}

.wc__preview {
  margin-top: 6px;
  padding: 10px 12px;
  border: 1px solid var(--ht-primary-line);
  border-radius: var(--ht-radius-sm);
  background: var(--ht-primary-soft);
}

.wc__preview-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--ht-primary);
}

.wc__preview-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 8px;
  font-size: 12px;
  color: var(--ht-text-2);
  flex-wrap: wrap;
}

.wc__preview-num {
  width: 110px;
}

.wc__preview-list {
  margin: 8px 0 0;
  padding-left: 18px;
  font-size: 11.5px;
  color: var(--ht-text-2);
  line-height: 1.8;
}

.wc__prompt-bar {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 8px;
  flex-wrap: wrap;
}

.wc__token {
  cursor: copy;
}

.wc__textarea :deep(textarea) {
  font-family: var(--ht-font-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace);
  font-size: 12px;
  line-height: 1.65;
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
