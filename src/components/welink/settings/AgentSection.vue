<script setup lang="ts">
/**
 * 设置卡·Agent 通道 + 提示词模板分区（自 SettingsCard 拆出，quality-hardening-2026-10 4.2）。
 *
 * v-model 承载 `WelinkSettings['agent']`（嵌套字段就地改、模板操作整字段替换——
 * 同一对象引用，父级 deep watch 照常触发热更新）。连通性测试结果经 `tested`
 * 事件上抛，由父级的共享结果框统一展示（与 CLI 试跑共用一处）。
 */
import { computed, ref } from 'vue'
import { ElMessage } from 'element-plus'

import { IconRefresh, IconRestore } from '@/components/icons'
import { useWelinkStore } from '@/stores/welink'
import {
  DEFAULT_PROMPT_TEMPLATE,
  PROMPT_PLACEHOLDERS,
  type WelinkSettings,
} from '@/types/welink'

const agent = defineModel<WelinkSettings['agent']>({ required: true })

const emit = defineEmits<{
  /** 连通性测试结果上抛（父级共享结果框展示；null = 清除） */
  (e: 'tested', result: { kind: 'agent'; ok: boolean; text: string } | null): void
}>()

const welinkStore = useWelinkStore()

/** 非回环 + 明文 HTTP 告警（S-3）。判据是「离开本机」且明文 —— 本地模型的
 * http://127.0.0.1 属正常用法，标红只会让告警变噪音。 */
const agentUrlInsecure = computed(() => {
  const url = agent.value.baseUrl.trim()
  if (!url || agent.value.agentSource !== 'http') return false
  if (!/^http:\/\//i.test(url)) return false
  const host = url
    .replace(/^https?:\/\//i, '')
    .split(/[/:?#]/)[0]
    .toLowerCase()
  return !['localhost', '127.0.0.1', '[::1]', '::1', '0.0.0.0'].includes(host)
})

/**
 * 两种接口风格的惯用 endpoint 默认值。
 *
 * 切换风格时只做「温和纠正」：当前路径为空、或恰好是另一种风格的默认值时，
 * 才自动换成新风格的默认值 —— 用户手填过自定义路径绝不覆盖。
 */
const STYLE_ENDPOINT_DEFAULTS = { simple: '/chat', openai: '/v1/chat/completions' } as const

function onAgentStyleChange(value: string | number | boolean | undefined) {
  const style = value === 'openai' ? 'openai' : 'simple'
  const current = agent.value.endpoint.trim()
  const other = style === 'openai' ? STYLE_ENDPOINT_DEFAULTS.simple : STYLE_ENDPOINT_DEFAULTS.openai
  if (!current || current === other) {
    agent.value = { ...agent.value, endpoint: STYLE_ENDPOINT_DEFAULTS[style] }
  }
}

const agentTesting = ref(false)

/**
 * 连通性测试：发固定探测 prompt，看耗时与返回摘要。
 *
 * 探测实例化收敛在 welink store（`probeAgent`，评审 A-1：独立实例、不挂管线
 * 录音钩子、不污染 R4 留痕语料）—— 组件不直触 infra（V1 治理）。
 */
async function testAgent() {
  agentTesting.value = true
  emit('tested', null)
  try {
    const settings = agent.value
    const started = Date.now()
    const reply = await welinkStore.probeAgent({ ...settings, timeoutMs: Math.min(settings.timeoutMs, 15_000) })
    const elapsed = Date.now() - started
    emit('tested', {
      kind: 'agent',
      ok: true,
      text: `耗时 ${elapsed}ms · 返回摘要：${reply.slice(0, 120)}${reply.length > 120 ? '…' : ''}`,
    })
    ElMessage.success('Agent 连通正常')
  } catch (error) {
    emit('tested', { kind: 'agent', ok: false, text: error instanceof Error ? error.message : String(error) })
    ElMessage.error('Agent 连通失败，请核对地址与端口')
  } finally {
    agentTesting.value = false
  }
}

/** 模板占位符缺失告警（设计 §11.6：变量缺失 → 保存警告） */
const missingPlaceholders = computed(() => PROMPT_PLACEHOLDERS.filter((token) => !agent.value.promptTemplate.includes(token)))

function restoreTemplate() {
  agent.value = { ...agent.value, promptTemplate: DEFAULT_PROMPT_TEMPLATE }
  ElMessage.success('已恢复内置提示词模板')
}

/** 插入占位符到模板末尾（省得手打 {{ }}） */
function insertPlaceholder(token: string) {
  agent.value = { ...agent.value, promptTemplate: `${agent.value.promptTemplate}\n${token}` }
}
</script>

<template>
  <!-- ⑥ Agent -->
  <el-collapse-item v-if="agent.agentSource === 'http'" name="agent" title="Agent 通道">
    <el-form :model="agent" label-width="140px" class="wc__form" @submit.prevent>
      <el-form-item label="服务地址">
        <el-input v-model="agent.baseUrl" class="wc__control" placeholder="http://10.0.0.5:8080" />
        <!-- S-3：请求体含完整聊天上下文，明文 HTTP 出内网即等于聊天记录裸奔 -->
        <span v-if="agentUrlInsecure" class="wc__warn">
          非回环地址 + 明文 HTTP：提示词（含聊天原文）会以明文离开本机，请确认在内网可信链路上
        </span>
      </el-form-item>
      <el-form-item label="接口风格">
        <el-radio-group v-model="agent.apiStyle" @change="onAgentStyleChange">
          <el-radio-button value="simple">内网服务（私有协议）</el-radio-button>
          <el-radio-button value="openai">OpenAI 兼容</el-radio-button>
        </el-radio-group>
        <span class="wc__hint">
          OpenAI 兼容 = /chat/completions 协议（vLLM / Ollama / 企业网关等）；私有协议按「{prompt} → {reply}」直连
        </span>
      </el-form-item>
      <el-form-item v-if="agent.apiStyle === 'openai'" label="大模型名称">
        <el-input v-model="agent.model" class="wc__control" placeholder="如 Qwen2.5-7B-Instruct / deepseek-r1:14b" />
        <span v-if="!agent.model.trim()" class="wc__warn">OpenAI 兼容接口必填 model，缺失时每次生成都将失败</span>
      </el-form-item>
      <el-form-item v-if="agent.apiStyle === 'openai'" label="API 密钥">
        <el-input
          v-model="agent.apiKey"
          class="wc__control"
          type="password"
          show-password
          autocomplete="new-password"
          placeholder="本地免鉴权服务可留空"
        />
        <span class="wc__hint">以 Authorization: Bearer 头随请求发送；仅存本机配置文件，不进日志、不进留痕语料</span>
      </el-form-item>
      <el-form-item label="接口路径">
        <el-input
          v-model="agent.endpoint"
          class="wc__control"
          :placeholder="agent.apiStyle === 'openai' ? '/v1/chat/completions' : '/chat'"
        />
      </el-form-item>
      <el-form-item label="超时">
        <el-input-number v-model="agent.timeoutMs" :min="1000" :max="300000" :step="1000" size="small" />
        <span class="wc__unit">毫秒</span>
      </el-form-item>
      <el-form-item label="上下文条数">
        <el-input-number v-model="agent.maxContextMsgs" :min="1" :max="200" size="small" />
        <span class="wc__unit">条</span>
        <span class="wc__hint">取该会话最近 N 条消息拼进提示词（客户端组装）</span>
      </el-form-item>
      <el-form-item label="">
        <el-button size="small" :icon="IconRefresh" :loading="agentTesting" @click="testAgent">连通性测试</el-button>
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
      <el-input v-model="agent.promptTemplate" type="textarea" :rows="14" class="wc__textarea" />
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
</template>

<style scoped>
.wc__form {
  padding-top: 6px;
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

.wc__warn {
  margin-left: 10px;
  font-size: 11.5px;
  color: var(--ht-warn);
  font-weight: 600;
}

.wc__control {
  width: 260px;
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

.wc__alert {
  margin: 10px 0;
}
</style>
