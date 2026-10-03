<script setup lang="ts">
/**
 * 设置卡·防滥发分区（S1–S8，O9 预设三档 + 拦截图预览）。
 *
 * 自 SettingsCard 拆出（quality-hardening-2026-10 4.2）：v-model 承载
 * `WelinkSettings['safety']` —— 字段级 v-model 就地改嵌套属性（同一对象引用，
 * 父级 deep watch 照常触发热更新），预设套用整对象替换（触发 update:modelValue）。
 */
import { computed, reactive } from 'vue'
import { ElMessage } from 'element-plus'

import { applySafetyPreset, DEFAULT_WELINK_SETTINGS, SAFETY_PRESETS, type WelinkSettings } from '@/types/welink'

const safety = defineModel<WelinkSettings['safety']>({ required: true })

// ---------------- O9 预设三档 ----------------

/** 当前档位：与预设值完全一致才算命中，否则显示「自定义」 */
const currentPreset = computed(() => {
  const value = safety.value
  return (
    SAFETY_PRESETS.find(
      (preset) =>
        preset.values.perConvMinIntervalSec === value.perConvMinIntervalSec &&
        preset.values.perConvHourlyCap === value.perConvHourlyCap &&
        preset.values.globalHourlyCap === value.globalHourlyCap &&
        preset.values.quietHoursEnabled === value.quietHours.enabled,
    )?.id ?? 'custom'
  )
})

const presetId = computed({
  get: () => currentPreset.value,
  set: (id: string) => {
    const preset = SAFETY_PRESETS.find((item) => item.id === id)
    if (!preset) return
    safety.value = applySafetyPreset(safety.value, preset)
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
    safety.value = { ...safety.value, [field]: DEFAULT_SAFETY[field] }
    return false
  }
  return true
}

// ---------------- 拦截图预览（O9 的「预览拦截效果」） ----------------

const preview = reactive({ perConv: 8, global: 12 })

/** 纯前端估算：把当前参数套到一个模拟场景上，直观说明哪条规则先命中 */
const previewResult = computed(() => {
  const value = safety.value
  const hits: string[] = []
  if (preview.perConv > value.perConvHourlyCap) hits.push(`S2 单会话小时上限（${value.perConvHourlyCap}）会先命中`)
  if (preview.global > value.globalHourlyCap) hits.push(`S3 全局小时上限（${value.globalHourlyCap}）会先命中`)
  if (value.perConvMinIntervalSec > 0) {
    hits.push(
      `S1 每条之间至少间隔 ${value.perConvMinIntervalSec}s，1 分钟内最多 ${Math.floor(60 / value.perConvMinIntervalSec) || 1} 条`,
    )
  }
  if (value.quietHours.enabled) hits.push(`S4 静默时段 ${value.quietHours.from}–${value.quietHours.to} 期间不外发`)
  if (value.mergeWindowSec > 0) hits.push(`S5 ${value.mergeWindowSec}s 内同会话重复内容会合并`)
  return hits
})
</script>

<template>
  <el-collapse-item name="safety" title="防滥发（SafetyGate 闸口）">
    <div class="wc__presets">
      <el-radio-group v-model="presetId">
        <el-radio-button v-for="preset in presetOptions" :key="preset.id" :value="preset.id" :title="preset.description">
          {{ preset.label }}
        </el-radio-button>
      </el-radio-group>
      <p class="wc__preset-desc">
        {{ presetOptions.find((item) => item.id === presetId)?.description }}
      </p>
    </div>

    <el-form :model="safety" label-width="120px" class="wc__form" @submit.prevent>
      <el-form-item label="S1 最小间隔">
        <el-input-number v-model="safety.perConvMinIntervalSec" :min="0" :max="600" :step="1" size="small" />
        <span class="wc__unit">秒 / 每会话</span>
        <span class="wc__hint">同一会话两次回复的最小间隔，跨重启仍然生效</span>
      </el-form-item>
      <el-form-item label="S2 会话小时上限">
        <el-input-number
          v-model="safety.perConvHourlyCap"
          :min="1"
          :max="500"
          size="small"
          @change="(value: number | undefined) => value && guardCapChange('perConvHourlyCap', value)"
        />
        <span class="wc__unit">条 / 小时</span>
      </el-form-item>
      <el-form-item label="S3 全局小时上限">
        <el-input-number
          v-model="safety.globalHourlyCap"
          :min="1"
          :max="1000"
          size="small"
          @change="(value: number | undefined) => value && guardCapChange('globalHourlyCap', value)"
        />
        <span class="wc__unit">条 / 小时</span>
        <span class="wc__hint">所有会话合计，超出后任务回「待发送」等下一小时</span>
      </el-form-item>
      <el-form-item label="S4 静默时段">
        <el-switch v-model="safety.quietHours.enabled" />
        <el-time-picker
          v-if="safety.quietHours.enabled"
          v-model="safety.quietHours.from"
          format="HH:mm"
          value-format="HH:mm"
          size="small"
          placeholder="开始"
          class="wc__time"
        />
        <span v-if="safety.quietHours.enabled" class="wc__unit">至</span>
        <el-time-picker
          v-if="safety.quietHours.enabled"
          v-model="safety.quietHours.to"
          format="HH:mm"
          value-format="HH:mm"
          size="small"
          placeholder="结束"
          class="wc__time"
        />
      </el-form-item>
      <el-form-item label="S5 合并窗口">
        <el-input-number v-model="safety.mergeWindowSec" :min="0" :max="3600" size="small" />
        <span class="wc__unit">秒</span>
        <span class="wc__hint">窗口内同一会话的重复触发只回一次</span>
      </el-form-item>
      <el-form-item label="S6 草稿长度上限">
        <el-input-number v-model="safety.maxDraftChars" :min="20" :max="4000" size="small" />
        <span class="wc__unit">字符</span>
      </el-form-item>
      <el-form-item label="S7 敏感句式黑名单">
        <div class="wc__patterns">
          <div v-for="(_, index) in safety.blacklistPatterns" :key="index" class="wc__pattern">
            <el-input v-model="safety.blacklistPatterns[index]" size="small" placeholder="正则表达式" />
            <el-button size="small" text type="danger" @click="safety.blacklistPatterns.splice(index, 1)">删除</el-button>
          </div>
          <el-button size="small" text @click="safety.blacklistPatterns.push('')">+ 添加一条</el-button>
          <p class="wc__hint">命中后转「人工待审」而不是丢弃：保留草稿让人判断，避免误伤正常回复</p>
        </div>
      </el-form-item>
      <el-form-item label="S8 熔断">
        <el-input-number v-model="safety.fuseWindowMin" :min="1" :max="1440" size="small" />
        <span class="wc__unit">分钟内同类拦截达</span>
        <el-input-number v-model="safety.fuseThreshold" :min="1" :max="100" size="small" />
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
</template>

<style scoped>
.wc__presets {
  padding: 10px 0 4px;
}

.wc__preset-desc {
  margin: 8px 0 0;
  font-size: 11.5px;
  color: var(--ht-text-3);
}

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

.wc__time {
  width: 110px;
  margin-left: 8px;
}

.wc__patterns {
  display: flex;
  flex-direction: column;
  gap: 6px;
  width: 100%;
  max-width: 560px;
}

.wc__patterns {
  display: flex;
  flex-direction: column;
  gap: 6px;
  width: 100%;
  max-width: 560px;
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
</style>
