<script setup lang="ts">
/**
 * Settings 页「大模型（Agent）」配置卡片 —— `WelinkSettings['agent']` 块的唯一编辑器。
 *
 * 为什么从 WeLink 助手卡（SettingsCard）里拆出来独立成卡：
 * 大模型连接是独立于消息通道的基础服务（docs/design-llm-connection-2026-10-02.md），
 * 且 2026-10-04 真实对接后连接参数（地址/路径/风格/密钥/模型名）成为高频配置项；
 * 原先整块藏在助手卡的 collapse 深处、mock 来源时还不可见。
 *
 * 单编辑器原则（防双卡互踩）：本卡是唯一 normalize 回写 agent 块的组件；
 * SettingsCard 对 agent 做**透传**（flushPush 用父级当前值回填），两卡并存
 * 不会互相重置草稿（评审 F-2 的双编辑器变体）。
 *
 * 双通道生效：
 *  * 持久化：emit → SettingsView 的 form.weLink → 「保存配置」落 config.json；
 *  * 热更新：applySettings 带全量 settings 应用（该函数不做字段级合并，只传
 *    { agent } 会把其余域重置回默认值）—— 未启动编排层时是空操作。
 */
import { computed, onBeforeUnmount, ref, watch } from 'vue'

import { IconAlert } from '@/components/icons'
import { useWelinkStore } from '@/stores/welink'
import { normalizeWelinkSettings, type WelinkSettings } from '@/types/welink'
import AgentSection from './settings/AgentSection.vue'

const props = defineProps<{ modelValue: Partial<WelinkSettings['agent']> }>()
const emit = defineEmits<{
  (e: 'update:modelValue', value: WelinkSettings['agent']): void
}>()

const welinkStore = useWelinkStore()

/** agent 块单独归一化：normalize 运行时按字段逐个兜底，但入参类型要求完整对象，这里收口窄化 */
function normalizeAgent(input: Partial<WelinkSettings['agent']>): WelinkSettings['agent'] {
  return normalizeWelinkSettings({ agent: input } as Partial<WelinkSettings>).agent
}

/** 归一化后的本地草稿：配置是可手改的 JSON，越界值必须在入口收敛 */
const draft = ref<WelinkSettings['agent']>(normalizeAgent(props.modelValue))
const activeGroup = ref<string[]>(['source', 'channel'])

/** 最近一次 push 出去的归一化结果（JSON）：父组件回写的同值不再重置草稿（评审 F-2 同款） */
let lastPushedJson = ''
let pushTimer: ReturnType<typeof setTimeout> | null = null

watch(
  () => props.modelValue,
  (value) => {
    const next = normalizeAgent(value)
    const nextJson = JSON.stringify(next)
    if (nextJson === lastPushedJson) return
    if (nextJson !== JSON.stringify(draft.value)) draft.value = next
  },
  { deep: true },
)

watch(draft, push, { deep: true })

/** 300ms 防抖：逐键 push 会造成逐键热更新与日志（与 SettingsCard 同款权衡） */
function push() {
  if (pushTimer) clearTimeout(pushTimer)
  pushTimer = setTimeout(flushPush, 300)
}

function flushPush() {
  pushTimer = null
  const normalized = normalizeAgent(draft.value)
  lastPushedJson = JSON.stringify(normalized)
  emit('update:modelValue', normalized)
  // agent 是全量 settings 的子块：带其余字段当前值整体应用，防止部分应用重置其它域
  welinkStore.applySettings({ ...welinkStore.settings, agent: normalized })
}

onBeforeUnmount(() => {
  if (pushTimer) clearTimeout(pushTimer)
})

// ---------------- 校验（提示不拦截；model 缺失在调用时 fail-fast，不发无效请求） ----------------
// 注：baseUrl 无「为空」告警 —— normalizeWelinkSettings 会把空/非法地址回退为默认值，
// 归一化草稿里 baseUrl 永不为空（原 SettingsCard 的同款告警实为死代码，随拆卡清理）。

const modelMissing = computed(
  () => draft.value.agentSource === 'http' && draft.value.apiStyle === 'openai' && !draft.value.model.trim(),
)

const sourceLabel = computed(() => (draft.value.agentSource === 'mock' ? '模拟回复' : '内网 HTTP'))
const styleLabel = computed(() => (draft.value.apiStyle === 'openai' ? 'OpenAI 兼容' : '私有协议'))

// ---------------- 连通性测试结果（按钮在 AgentSection 通道表单内，结果经 tested 事件上抛展示） ----------------

const testResult = ref<{ ok: boolean; text: string } | null>(null)
</script>

<template>
  <section class="ht-card llm">
    <header class="ht-card__head">
      <span>大模型（Agent）</span>
      <span class="spacer" />
      <el-tag size="small" effect="plain" round>{{ sourceLabel }}</el-tag>
      <el-tag size="small" effect="plain" round>{{ styleLabel }}</el-tag>
      <el-tag v-if="draft.apiStyle === 'openai'" size="small" effect="plain" round>
        {{ draft.model.trim() || 'model 未填' }}
      </el-tag>
    </header>

    <div class="llm__body">
      <el-alert
        v-if="modelMissing"
        class="llm__alert"
        type="warning"
        :closable="false"
        show-icon
        title="OpenAI 兼容接口未填写大模型名称（model）"
        description="该风格下 model 为必填字段，缺失时每次生成都会在本机直接报错（不发出无效请求）。填写后重新保存即可生效。"
      />

      <el-collapse v-model="activeGroup">
        <!-- ① 回复来源（真假的开关，原在 WeLink 助手卡总览，随 agent 块一起移交本卡） -->
        <el-collapse-item name="source" title="回复来源">
          <el-form :model="draft" label-width="140px" class="llm__form" @submit.prevent>
            <el-form-item label="回复来源">
              <el-radio-group v-model="draft.agentSource">
                <el-radio-button value="mock">模拟回复</el-radio-button>
                <el-radio-button value="http">内网 HTTP</el-radio-button>
              </el-radio-group>
              <span class="llm__hint">立即生效。模拟回复用于无模型环境的演示与测试；连接参数仅在「内网 HTTP」下参与运行</span>
            </el-form-item>
          </el-form>
        </el-collapse-item>

        <!-- ② 连接配置 + ③ 提示词模板（AgentSection，字段定义见该组件） -->
        <AgentSection v-model="draft" @tested="testResult = $event" />
      </el-collapse>

      <!-- 连通性测试结果 -->
      <el-alert
        v-if="testResult"
        class="llm__alert"
        :type="testResult.ok ? 'success' : 'error'"
        :closable="true"
        show-icon
        title="Agent 连通性结果"
        @close="testResult = null"
      >
        <pre class="llm__test-text">{{ testResult.text }}</pre>
      </el-alert>

      <p class="llm__foot">
        <IconAlert class="llm__foot-icon" />
        <span class="llm__foot-text">
          改动经「保存配置」写入本机 config.json（API 密钥仅随请求头发送，不进日志与留痕语料）；未保存前也会热更新到运行中的助手。
        </span>
      </p>
    </div>
  </section>
</template>

<style scoped>
.llm {
  display: flex;
  flex-direction: column;
}

.ht-card__head .spacer,
.spacer {
  flex: 1;
}

.llm__body {
  padding: 6px 16px 14px;
}

.llm__alert {
  margin: 10px 0;
}

.llm__form {
  padding-top: 6px;
}

.llm__form :deep(.el-form-item) {
  margin-bottom: 14px;
}

.llm__hint {
  margin-left: 10px;
  font-size: 11.5px;
  color: var(--ht-text-3);
  line-height: 1.7;
}

.llm__test-text {
  margin: 0;
  font-size: 11.5px;
  line-height: 1.7;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.llm__foot {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 12px 0 0;
  font-size: 11.5px;
  color: var(--ht-text-3);
  line-height: 1.7;
}

.llm__foot-icon {
  width: 14px;
  height: 14px;
  color: var(--ht-warn);
  flex-shrink: 0;
}

.llm__foot-text {
  flex: 1;
}
</style>
