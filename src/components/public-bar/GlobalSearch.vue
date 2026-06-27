<script setup lang="ts">
import { ref } from 'vue'
import { NInput, NButton, NSpace } from 'naive-ui'
import { useSearch } from '@/composables/use-search'

const keyword = ref('')
const { search, searching } = useSearch()

function handleSearch() {
  if (keyword.value.trim()) {
    search([], keyword.value.trim())
  }
}
</script>

<template>
  <NSpace align="center" :size="8">
    <NInput
      v-model:value="keyword"
      type="text"
      placeholder="全局搜索..."
      clearable
      style="width: 240px;"
      @keyup.enter="handleSearch"
    />
    <NButton type="primary" :loading="searching" @click="handleSearch">
      搜索
    </NButton>
  </NSpace>
</template>
