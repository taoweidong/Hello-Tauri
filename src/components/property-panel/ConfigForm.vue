<script setup lang="ts">
import { computed } from 'vue'
import { NForm, NFormItem, NInput, NSelect, NSwitch, NInputNumber, NText } from 'naive-ui'
import { useTabManager } from '@/composables/use-tabs'
import { usePluginEngine } from '@/composables/use-plugins'

const { activeTab } = useTabManager()
const { registry } = usePluginEngine()

const configSchema = computed(() => {
  if (!activeTab.value) return null
  const ext = '.' + (activeTab.value.fileNode.label.split('.').pop() ?? '')
  const plugin = registry.getParser(ext)
  return plugin?.getConfigSchema?.() ?? null
})
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
        <NInput v-if="field.type === 'input'" :default-value="field.default" size="small" />
        <NSelect v-else-if="field.type === 'select'" :options="field.options" :default-value="field.default" size="small" />
        <NSwitch v-else-if="field.type === 'switch'" :default-value="field.default" />
        <NInputNumber v-else-if="field.type === 'number'" :default-value="field.default" size="small" />
      </NFormItem>
    </NForm>
  </div>
</template>
