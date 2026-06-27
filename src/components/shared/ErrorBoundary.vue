<script setup lang="ts">
import { ref, onErrorCaptured } from 'vue'
import { NResult, NButton } from 'naive-ui'

const error = ref<Error | null>(null)

onErrorCaptured((err) => {
  error.value = err instanceof Error ? err : new Error(String(err))
  return false
})

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
