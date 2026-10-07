<script setup lang="ts">
/**
 * Settings 页「知识沉淀」配置卡 —— `WelinkSettings['sediment']` 块的唯一编辑器
 * （knowledge-sedimentation）。与 RagSettingsCard 同款约定：改动经 300ms 防抖
 * 上抛（持久化 + applySettings 热更新）；「立即提取」走 knowledgeStore.runOnce
 * （与自动调度共用 single-flight）；web 调试模式文件通道不可用 → 整卡降级。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'

import { useKnowledgeStore } from '@/stores/welink/knowledge'
import { useWelinkStore } from '@/stores/welink'
import { normalizeWelinkSettings, type WelinkSedimentSettings, type WelinkSettings } from '@/types/welink'

const props = defineProps<{ modelValue: Partial<WelinkSedimentSettings> }>()
const emit = defineEmits<{
  (e: 'update:modelValue', value: WelinkSedimentSettings): void
}>()

const welinkStore = useWelinkStore()
const knowledgeStore = useKnowledgeStore()

function normalizeSediment(input: Partial<WelinkSedimentSettings>): WelinkSedimentSettings {
  return normalizeWelinkSettings({ sediment: input } as Partial<WelinkSettings>).sediment
}

const draft = ref<WelinkSedimentSettings>(normalizeSediment(props.modelValue))
const activeGroup = ref<string[]>(['sediment'])

let lastPushedJson = ''
let pushTimer: ReturnType<typeof setTimeout> | null = null

watch(
  () => props.modelValue,
  (value) => {
    const next = normalizeSediment(value)
    const nextJson = JSON.stringify(next)
    if (nextJson === lastPushedJson) return
    if (nextJson !== JSON.stringify(draft.value)) draft.value = next
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
  const normalized = normalizeSediment(draft.value)
  lastPushedJson = JSON.stringify(normalized)
  emit('update:modelValue', normalized)
  welinkStore.applySettings({ ...welinkStore.settings, sediment: normalized })
}

onBeforeUnmount(() => {
  if (pushTimer) clearTimeout(pushTimer)
})

// —— 白名单会话选项（与监控会话同一份清单） ——

interface ConvOption {
  value: string
  label: string
}
const convOptions = computed<ConvOption[]>(() =>
  welinkStore.conversations.map((conv) => ({ value: conv.convId, label: conv.title || conv.convId })),
)

onMounted(() => {
  void welinkStore.loadConversations().catch(() => undefined)
  void knowledgeStore.loadLogs().catch(() => undefined)
})

// —— 立即提取 ——

const running = computed(() => knowledgeStore.busy)

async function extractNow() {
  try {
    const report = await knowledgeStore.runOnce()
    if (!report) return
    if (report.skipped === 'disabled') {
      ElMessage.warning('知识沉淀总开关未开启')
      return
    }
    if (report.skipped === 'fail_streak') {
      ElMessage.error('提取连续失败已达阈值，请检查模型服务后重试')
      return
    }
    if (report.error) {
      ElMessage.warning(`本轮部分失败：${report.error}`)
      return
    }
    ElMessage.success(
      `提取完成：消息 ${report.messageCount} 条、公告 ${report.announcementCount} 条、归档问答 ${report.qaArchived} 条、新增知识 ${report.draftCount} 条`,
    )
  } catch (error) {
    ElMessage.error(`提取失败：${error instanceof Error ? error.message : String(error)}`)
  }
}

const modeWarn = computed(() => draft.value.mode === 'auto')

/** docs 占位符字面量（模板内嵌花括号会被 mustache 解析器截断，经常量注入） */
const DOCS_TOKEN = '{{docs}}'

const reportText = computed(() => {
  const report = knowledgeStore.lastReport
  if (!report) return ''
  const parts = [
    `${report.ranAt}`,
    `消息 ${report.messageCount}`,
    `公告 ${report.announcementCount}`,
    `归档 ${report.qaArchived}`,
    `新增 ${report.draftCount}`,
  ]
  if (report.skipped) parts.push(report.skipped === 'disabled' ? '已停用' : '连续失败跳过')
  if (report.error) parts.push(`异常：${report.error}`)
  return parts.join(' · ')
})
</script>

<template>
  <section class="ht-card sed">
    <header class="ht-card__head">
      <span>知识沉淀</span>
      <span class="spacer" />
      <el-tag size="small" effect="plain" round>{{ draft.enabled ? '运行中' : '已停用' }}</el-tag>
    </header>

    <div class="sed__body">
      <template v-if="knowledgeStore.fsAvailable">
        <el-collapse v-model="activeGroup">
          <el-collapse-item name="sediment" title="沉淀设置">
            <el-form :model="draft" label-width="140px" class="sed__form" @submit.prevent>
              <el-form-item label="沉淀总开关">
                <el-switch v-model="draft.enabled" />
                <span class="sed__hint">开启后按周期自动提取；提取与自动回复相互独立，全程纯本地写入</span>
              </el-form-item>
              <el-form-item label="沉淀白名单">
                <el-select
                  v-model="draft.sessions"
                  multiple
                  filterable
                  clearable
                  placeholder="选择参与沉淀的群会话"
                  class="sed__control"
                >
                  <el-option
                    v-for="option in convOptions"
                    :key="option.value"
                    :value="option.value"
                    :label="option.label"
                  />
                </el-select>
                <span class="sed__hint"
                  >仅白名单会话的群消息参与提取；群公告与已答复问答不受此限（公告按白名单会话拉取）</span
                >
              </el-form-item>
              <el-form-item label="提取周期">
                <el-input-number v-model="draft.intervalHours" :min="1" :max="72" :step="1" />
                <span class="sed__hint">小时；自动调度每轮按此间隔执行（改后立即生效，无需重启）</span>
              </el-form-item>
              <el-form-item label="评审模式">
                <el-radio-group v-model="draft.mode">
                  <el-radio-button value="manual">人工评审</el-radio-button>
                  <el-radio-button value="auto">免审直通</el-radio-button>
                </el-radio-group>
                <el-alert
                  v-if="modeWarn"
                  class="sed__warn"
                  type="warning"
                  :closable="false"
                  show-icon
                  title="免审直通：提取条目将跳过人工确认直接写入知识库"
                  description="群消息是不可信来源，直通等于信任模型整理出的全部内容；建议仅在能定期复核知识库时开启。"
                />
              </el-form-item>
              <el-form-item label="问答归档">
                <el-switch v-model="draft.qaArchive" />
                <span class="sed__hint"
                  >已答复问答按「技能 × 月份」追加进 knowledge/qa-archive/，作为可路由的经验沉淀</span
                >
              </el-form-item>
              <el-form-item label="文档注入上限">
                <el-input-number v-model="draft.docsMaxChars" :min="200" :max="8000" :step="100" />
                <span class="sed__hint">字符；技能绑定知识文档经 {{ DOCS_TOKEN }} 注入提示词的总长上限</span>
              </el-form-item>
            </el-form>
          </el-collapse-item>
        </el-collapse>

        <div class="sed__toolbar">
          <el-button size="small" type="primary" :loading="running" :disabled="!draft.enabled" @click="extractNow"
            >立即提取</el-button
          >
          <span v-if="reportText" class="sed__report mono">{{ reportText }}</span>
        </div>

        <ul v-if="knowledgeStore.logs.length" class="sed__logs">
          <li v-for="log in knowledgeStore.logs" :key="log.pk" class="sed__log mono">
            <el-tag size="small" :type="log.status === 'ok' ? 'success' : 'danger'" effect="plain">{{
              log.status
            }}</el-tag>
            <span class="sed__log-time">{{ log.createdAt }}</span>
            <span class="sed__log-text">{{ log.error || log.prompt.slice(0, 60) }}</span>
          </li>
        </ul>
      </template>

      <el-alert
        v-else
        type="info"
        :closable="false"
        show-icon
        title="知识沉淀需桌面模式"
        description="浏览器调试模式下文件通道不可用；沉淀链路可在桌面模式或经 mock 端口演示。"
      />
    </div>
  </section>
</template>

<style scoped>
.sed {
  display: flex;
  flex-direction: column;
}

.ht-card__head .spacer,
.spacer {
  flex: 1;
}

.sed__body {
  padding: 6px 16px 14px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.sed__form :deep(.el-form-item) {
  margin-bottom: 10px;
}

.sed__hint {
  font-size: 11.5px;
  color: var(--ht-text-3);
  line-height: 1.7;
  margin-left: 10px;
}

.sed__control {
  width: 320px;
}

.sed__warn {
  margin-top: 6px;
  width: 100%;
}

.sed__toolbar {
  display: flex;
  align-items: center;
  gap: 10px;
}

.sed__report {
  font-size: 11px;
  color: var(--ht-text-3);
}

.sed__logs {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-height: 160px;
  overflow: auto;
}

.sed__log {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 11px;
  color: var(--ht-text-3);
}

.sed__log-time {
  flex-shrink: 0;
}

.sed__log-text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.mono {
  font-family: var(--ht-font-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace);
}
</style>
