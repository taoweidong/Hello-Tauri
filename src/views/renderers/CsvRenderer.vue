<script setup lang="ts">
import { NEmpty } from 'naive-ui'

defineProps<{ content: { headers: string[]; rows: string[][] } }>()
</script>

<template>
  <NEmpty
    v-if="content.headers.length === 0 && content.rows.length === 0"
    description="空表格"
    style="margin-top: 40px;"
  />
  <div v-else class="csv-renderer">
    <table>
      <thead>
        <tr>
          <th v-for="(h, i) in content.headers" :key="i">{{ h }}</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="(row, ri) in content.rows" :key="ri">
          <td v-for="(cell, ci) in row" :key="ci">{{ cell }}</td>
        </tr>
      </tbody>
    </table>
  </div>
</template>

<style scoped>
.csv-renderer {
  overflow: auto;
  height: 100%;
  background: #1a1a2e;
}
table {
  border-collapse: collapse;
  width: 100%;
  font-size: 14px;
  font-family: "JetBrains Mono", monospace;
}
th, td {
  border: 1px solid #333;
  padding: 4px 8px;
  color: #d4d4d4;
}
th {
  position: sticky;
  top: 0;
  background: #16213e;
}
</style>
