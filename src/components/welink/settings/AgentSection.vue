<script setup lang="ts">
/**
 * 大模型卡·连接配置 + 提示词模板分区（原 WeLink 助手卡分区，2026-10-04 随 agent 块
 * 移交独立的 LlmSettingsCard 承载）。
 *
 * v-model 承载 `WelinkSettings['agent']`（嵌套字段就地改、模板操作整字段替换——
 * 同一对象引用，父级 deep watch 照常触发热更新）。连通性测试结果经 `tested`
 * 事件上抛，由父级的结果框统一展示。
 *
 * 行为要点：连接配置**不随「模拟回复」来源隐藏** —— 大模型配置卡的价值就是让
 * 连接参数随时可见可改；「回复来源」开关并入本表单第一行（它管辖的正是下方
 * 连接参数），mock 来源下探测按钮禁用。协议只有一种（OpenAI 兼容，见类型层
 * 注释），无接口风格选择。
 */
import { computed, ref } from 'vue'
import { ElMessage } from 'element-plus'

import { IconRefresh, IconRestore } from '@/components/icons'
import { useWelinkStore } from '@/stores/welink'
import { DEFAULT_PROMPT_TEMPLATE, PROMPT_PLACEHOLDERS, type WelinkSettings } from '@/types/welink'

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

/** 模板占位符缺失告警（设计 §11.6：变量缺失 → 保存警告）。只查**必填**变量：
 * knowledge/retrieved/docs 是可选注入口（D-E / K-F：模板未包含即不注入，属正常形态），
 * 全量过滤会让告警在默认模板上常驻假红（uitest「无降级告警」实测 2026-10-07 被它打红）。 */
const missingPlaceholders = computed(() =>
  ['{{context}}', '{{question}}'].filter((token) => !agent.value.promptTemplate.includes(token)),
)

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
  <!-- ⑥ 回复来源 + 连接配置（来源开关就管下方连接参数，同表单呈现；mock 来源下字段常显） -->
  <el-collapse-item name="agent" title="连接配置">
    <el-form :model="agent" label-width="140px" class="wc__form" @submit.prevent>
      <el-form-item label="回复来源">
        <el-radio-group v-model="agent.agentSource">
          <el-radio-button value="mock">模拟回复</el-radio-button>
          <el-radio-button value="http">模型接口</el-radio-button>
        </el-radio-group>
        <span class="wc__hint">
          立即生效；模拟回复用于无模型环境的演示与测试，下方连接参数仅在「模型接口」下参与运行
        </span>
      </el-form-item>
      <el-form-item label="服务地址">
        <el-input v-model="agent.baseUrl" class="wc__control" placeholder="https://llm-gateway.example.com/v1" />
        <!-- S-3：请求体含完整聊天上下文，明文 HTTP 离开本机即等于聊天记录裸奔 -->
        <span v-if="agentUrlInsecure" class="wc__warn">
          非回环地址 + 明文 HTTP：提示词（含聊天原文）会以明文离开本机，请确认链路可信或改用 https
        </span>
      </el-form-item>
      <el-form-item label="大模型名称">
        <el-input v-model="agent.model" class="wc__control" placeholder="如 qwen3.8-flash / deepseek-r1:14b" />
        <span v-if="!agent.model.trim()" class="wc__warn"
          >必填 model，缺失时每次生成都将失败（本机直接报错，不发无效请求）</span
        >
      </el-form-item>
      <el-form-item label="API 密钥">
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
        <el-input v-model="agent.endpoint" class="wc__control" placeholder="/v1/chat/completions" />
        <span class="wc__hint">
          OpenAI 兼容 /chat/completions 协议（Ollama / vLLM / 企业网关 / 公有云 MaaS）；服务地址已含 /v1 类前缀时只填
          /chat/completions
        </span>
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
        <el-button
          size="small"
          :icon="IconRefresh"
          :loading="agentTesting"
          :disabled="agent.agentSource !== 'http'"
          @click="testAgent"
          >连通性测试</el-button
        >
        <span class="wc__hint">发送固定探测提示词，显示耗时与返回摘要（来源为模拟回复时按钮不可用）</span>
      </el-form-item>
    </el-form>
  </el-collapse-item>

  <!-- ⑦ 兜底技能（skill-routing：原「提示词模板」语义收窄为内置兜底技能的模板与知识块，D4） -->
  <el-collapse-item name="prompt" title="兜底技能（通用助手）">
    <div class="wc__prompt">
      <p class="wc__lead">
        未命中任何回复技能时使用本模板回复（老配置升级零迁移）；分类问题的专属模板请在「回复技能」分区配置。
      </p>
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
      <el-form-item label="知识块" class="wc__knowledge">
        <el-input
          v-model="agent.fallbackKnowledge"
          type="textarea"
          :rows="4"
          placeholder="通用口径 / FAQ（可选），注入上方模板的 {{knowledge}} 占位符"
        />
        <span class="wc__hint">可信文本，只进提示词、永不作为回复正文外发；技能级知识块在「回复技能」分区配置</span>
      </el-form-item>
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

.wc__lead {
  margin: 0 0 8px;
  font-size: 12px;
  color: var(--ht-text-3);
  line-height: 1.7;
}

.wc__knowledge {
  margin-top: 10px;
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
