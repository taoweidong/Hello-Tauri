<script setup lang="ts">
/**
 * 统一图标渲染组件
 *
 * 从本地静态 path 数据表（icon-paths.ts）渲染描边式 SVG，
 * 无 v-html / 无 CDN / 无 icon font，编译产物完全自包含。
 */
import { computed } from 'vue'
import { ICON_PATHS, type IconName } from './icon-paths'

const props = withDefaults(defineProps<{
  /** 图标名 */
  name: IconName
  /** 尺寸（px），默认 16 */
  size?: number
  /** 描边宽度，默认 1.75 */
  strokeWidth?: number
  /** 是否旋转（loader 类图标） */
  spin?: boolean
}>(), {
  size: 16,
  strokeWidth: 1.75,
  spin: false,
})

/** 当前图标的路径列表 */
const paths = computed<readonly string[]>(() => ICON_PATHS[props.name] ?? [])
</script>

<template>
  <svg
    :width="size"
    :height="size"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    :stroke-width="strokeWidth"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
    :class="['app-icon', 'shrink-0', { 'app-icon--spin': spin }]"
  >
    <path v-for="(d, i) in paths" :key="i" :d="d" />
  </svg>
</template>

<style scoped>
.app-icon {
  display: inline-block;
  vertical-align: -0.125em;
}
.app-icon--spin {
  animation: app-icon-spin 1.6s linear infinite;
}
@keyframes app-icon-spin {
  to { transform: rotate(360deg); }
}
@media (prefers-reduced-motion: reduce) {
  .app-icon--spin {
    animation-duration: 6s;
  }
}
</style>
