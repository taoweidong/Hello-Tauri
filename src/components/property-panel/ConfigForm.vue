<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { NForm, NFormItem, NInput, NSelect, NSwitch, NInputNumber, NText } from 'naive-ui'
import { useTabManager } from '@/composables/use-tabs'
import { usePluginEngine } from '@/composables/use-plugins'

const { activeTab } = useTabManager()
const { registry } = usePluginEngine()

/** 当前表单值（响应式） */
const formValues = ref<Record<string, any>>({})

const configSchema = computed(() => {
  if (!activeTab.value) return null
  const ext = '.' + (activeTab.value.fileNode.label.split('.').pop() ?? '')
  const plugin = registry.getParser(ext)
  return plugin?.getConfigSchema?.() ?? null
})

/** 标签页切换时重置表单默认值 */
watch(configSchema, (schema) => {
  if (!schema) return
  const defaults: Record<string, any> = {}
  for (const field of schema.fields) {
    defaults[field.key] = field.default
  }
  formValues.value = defaults
}, { immediate: true })
</script>

<template>
  <div v-if="configSchema" style="margin-top: 12px;">
    <NText strong depth="2" style="font-size: 12px; display: block; margin-bottom: 8px;">
      插件配置
    </NText>
    <NForm label-placement="left" size="small">
      <NFormItem
        v-for="field in configSchema.fields"
        :key="field.key"
        :label="field.label"
      >
        <NInput v-if="field.type === 'input'" v-model:value="formValues[field.key]" size="small" />
        <NSelect v-else-if="field.type === 'select'" v-model:value="formValues[field.key]" :options="field.options" size="small" />
        <NSwitch v-else-if="field.type === 'switch'" v-model:value="formValues[field.key]" />
        <NInputNumber v-else-if="field.type === 'number'" v-model:value="formValues[field.key]" size="small" />
        <NInput v-else v-model:value="formValues[field.key]" size="small" />
      </NFormItem>
    </NForm>
  </div>
</template>
