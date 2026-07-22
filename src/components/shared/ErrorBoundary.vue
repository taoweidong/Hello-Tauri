<script setup lang="ts">
/**
 * 错误边界组件
 * 捕获子组件渲染异常，展示错误信息与重试按钮，防止全局崩溃
 */
import { ref, onErrorCaptured } from 'vue'
import { NResult, NButton } from 'naive-ui'

const error = ref<Error | null>(null)

onErrorCaptured((err) => {
  error.value = err instanceof Error ? err : new Error(String(err))
  return false
})

/** 重置错误状态，重新渲染子组件 */
function reset() {
  error.value = null
}
</script>

<template>
  <NResult
    v-if="error"
    status="error"
    title="渲染异常"
    :description="error.message"
  >
    <template #footer>
      <NButton @click="reset">重试</NButton>
    </template>
  </NResult>
  <slot v-else />
</template>
