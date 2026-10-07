<script setup lang="ts">
/**
 * Settings 页「知识检索（RAG）」配置卡 —— `WelinkSettings['rag']` 块的唯一编辑器。
 *
 * 与 LlmSettingsCard 同款约定（防双卡互踩）：本卡是唯一 normalize 回写 rag 块的
 * 组件；改动经 300ms 防抖上抛（持久化 + applySettings 热更新全量 settings）。
 * 「测试检索」走 store 的 probeRag（独立探针实例，不进缓存、不产生留痕）。
 */
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'

import { IconRefresh } from '@/components/icons'
import { useWelinkStore } from '@/stores/welink'
import { normalizeWelinkSettings, type WelinkRagSettings, type WelinkSettings } from '@/types/welink'

const props = defineProps<{ modelValue: Partial<WelinkRagSettings> }>()
const emit = defineEmits<{
  (e: 'update:modelValue', value: WelinkRagSettings): void
}>()

const welinkStore = useWelinkStore()

function normalizeRag(input: Partial<WelinkRagSettings>): WelinkRagSettings {
  return normalizeWelinkSettings({ rag: input } as Partial<WelinkSettings>).rag
}

const draft = ref<WelinkRagSettings>(normalizeRag(props.modelValue))
const activeGroup = ref<string[]>(['rag'])

let lastPushedJson = ''
let pushTimer: ReturnType<typeof setTimeout> | null = null

watch(
  () => props.modelValue,
  (value) => {
    const next = normalizeRag(value)
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
  const normalized = normalizeRag(draft.value)
  lastPushedJson = JSON.stringify(normalized)
  emit('update:modelValue', normalized)
  welinkStore.applySettings({ ...welinkStore.settings, rag: normalized })
}

onBeforeUnmount(() => {
  if (pushTimer) clearTimeout(pushTimer)
})

const sourceLabel = computed(() => (draft.value.ragSource === 'mock' ? '模拟检索' : '检索服务'))
const insecureUrl = computed(() => {
  const url = draft.value.baseUrl.trim()
  if (!url || draft.value.ragSource !== 'http') return false
  if (!/^http:\/\//i.test(url)) return false
  const host = url
    .replace(/^https?:\/\//i, '')
    .split(/[/:?#]/)[0]
    .toLowerCase()
  return !['localhost', '127.0.0.1', '[::1]', '::1', '0.0.0.0'].includes(host)
})

const testing = ref(false)
const testResult = ref<{ ok: boolean; text: string } | null>(null)

async function testRag() {
  testing.value = true
  testResult.value = null
  try {
    const result = await welinkStore.probeRag({ ...draft.value, timeoutMs: Math.min(draft.value.timeoutMs, 15_000) })
    testResult.value = { ok: true, text: `耗时 ${result.latencyMs}ms · ${result.preview}` }
    ElMessage.success('RAG 检索可达')
  } catch (error) {
    testResult.value = { ok: false, text: error instanceof Error ? error.message : String(error) }
    ElMessage.error('RAG 检索失败，请核对地址与接口路径')
  } finally {
    testing.value = false
  }
}
</script>

<template>
  <section class="ht-card rag">
    <header class="ht-card__head">
      <span>知识检索（RAG）</span>
      <span class="spacer" />
      <el-tag size="small" effect="plain" round>{{ sourceLabel }}</el-tag>
    </header>

    <div class="rag__body">
      <el-collapse v-model="activeGroup">
        <el-collapse-item name="rag" title="检索服务">
          <el-form :model="draft" label-width="140px" class="rag__form" @submit.prevent>
            <el-form-item label="检索来源">
              <el-radio-group v-model="draft.ragSource">
                <el-radio-button value="mock">模拟检索</el-radio-button>
                <el-radio-button value="http">检索服务</el-radio-button>
              </el-radio-group>
              <span class="rag__hint">
                模拟检索用内置语料演示「检索 → 注入」链路；真实服务按 [RAG-ASSUME] 清单核实后切换
              </span>
            </el-form-item>
            <el-form-item label="服务地址">
              <el-input v-model="draft.baseUrl" class="rag__control" placeholder="http://rag.intranet.example.com" />
              <span v-if="insecureUrl" class="rag__warn">
                非回环地址 + 明文 HTTP：检索请求含对话原文，会以明文离开本机，请确认链路可信或改用 https
              </span>
            </el-form-item>
            <el-form-item label="接口路径">
              <el-input v-model="draft.endpoint" class="rag__control" placeholder="/search" />
              <span class="rag__hint"
                >POST 检索接口；请求体 { query, top_k, filter? }，字段容错清单见设计文档 [RAG-ASSUME]</span
              >
            </el-form-item>
            <el-form-item label="API 密钥">
              <el-input
                v-model="draft.apiKey"
                class="rag__control"
                type="password"
                show-password
                autocomplete="new-password"
                placeholder="免鉴权服务可留空"
              />
              <span class="rag__hint">Bearer 头随请求发送；仅存本机配置，不进日志与留痕语料</span>
            </el-form-item>
            <el-form-item label="超时">
              <el-input-number v-model="draft.timeoutMs" :min="1000" :max="60000" :step="1000" size="small" />
              <span class="rag__unit">毫秒</span>
              <span class="rag__hint">检索超时即静默降级为无检索生成，不阻断回复</span>
            </el-form-item>
            <el-form-item label="取回条数">
              <el-input-number v-model="draft.topK" :min="1" :max="10" size="small" />
              <span class="rag__unit">条</span>
            </el-form-item>
            <el-form-item label="相关度阈值">
              <el-input-number v-model="draft.minScore" :min="0" :max="1" :step="0.05" size="small" />
              <span class="rag__hint">低于阈值的片段不注入（0 = 不过滤）</span>
            </el-form-item>
            <el-form-item label="注入长度上限">
              <el-input-number v-model="draft.maxChars" :min="200" :max="4000" :step="100" size="small" />
              <span class="rag__unit">字符</span>
            </el-form-item>
            <el-form-item label="兜底技能检索">
              <el-switch v-model="draft.fallbackRetrieve" size="small" />
              <span class="rag__hint">未命中任何技能（通用助手）时也检索；默认关，避免无差别检索</span>
            </el-form-item>
            <el-form-item label="">
              <el-button
                size="small"
                :icon="IconRefresh"
                :loading="testing"
                :disabled="draft.ragSource !== 'http'"
                @click="testRag"
                >测试检索</el-button
              >
              <span class="rag__hint">固定探测问题，显示耗时与命中片段摘要（模拟来源时按钮不可用）</span>
            </el-form-item>
          </el-form>
        </el-collapse-item>
      </el-collapse>

      <el-alert
        v-if="testResult"
        class="rag__alert"
        :type="testResult.ok ? 'success' : 'error'"
        :closable="true"
        show-icon
        title="RAG 检索结果"
        @close="testResult = null"
      >
        <pre class="rag__test-text">{{ testResult.text }}</pre>
      </el-alert>

      <p class="rag__foot">
        <span class="rag__foot-text">
          检索在生成段进行（失败静默降级）；命中片段随生成提示词落入「Agent 回溯」语料，可回溯检索到了什么。
        </span>
      </p>
    </div>
  </section>
</template>

<style scoped>
.rag {
  display: flex;
  flex-direction: column;
}

.ht-card__head .spacer,
.spacer {
  flex: 1;
}

.rag__body {
  padding: 6px 16px 14px;
}

.rag__form {
  padding-top: 6px;
}

.rag__unit {
  margin-left: 8px;
  font-size: 12px;
  color: var(--ht-text-3);
}

.rag__hint {
  margin-left: 10px;
  font-size: 11.5px;
  color: var(--ht-text-3);
  line-height: 1.7;
}

.rag__warn {
  margin-left: 10px;
  font-size: 11.5px;
  color: var(--ht-warn);
  font-weight: 600;
}

.rag__control {
  width: 260px;
}

.rag__alert {
  margin: 10px 0;
}

.rag__test-text {
  margin: 0;
  font-size: 11.5px;
  line-height: 1.7;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.rag__foot {
  margin: 12px 0 0;
  font-size: 11.5px;
  color: var(--ht-text-3);
  line-height: 1.7;
}
</style>
