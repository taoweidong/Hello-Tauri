<script setup lang="ts">
/**
 * 应用 Logo SVG 组件
 * 替代 v-html 注入方式，消除 XSS 风险
 */
</script>

<template>
  <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M12 2L3.5 6.5V17.5L12 22L20.5 17.5V6.5L12 2Z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/>
    <path d="M12 2V22" stroke="currentColor" stroke-width="0.6" opacity="0.3"/>
    <path d="M3.5 6.5L20.5 17.5" stroke="currentColor" stroke-width="0.6" opacity="0.3"/>
    <path d="M20.5 6.5L3.5 17.5" stroke="currentColor" stroke-width="0.6" opacity="0.3"/>
    <circle cx="12" cy="12" r="3" stroke="currentColor" stroke-width="1.2"/>
    <circle cx="12" cy="12" r="1" fill="currentColor"/>
    <circle cx="12" cy="5" r="0.8" fill="currentColor" opacity="0.7"/>
    <circle cx="12" cy="19" r="0.8" fill="currentColor" opacity="0.7"/>
    <circle cx="6" cy="8.5" r="0.8" fill="currentColor" opacity="0.7"/>
    <circle cx="18" cy="8.5" r="0.8" fill="currentColor" opacity="0.7"/>
    <circle cx="6" cy="15.5" r="0.8" fill="currentColor" opacity="0.7"/>
    <circle cx="18" cy="15.5" r="0.8" fill="currentColor" opacity="0.7"/>
    <path d="M12 5L12 9" stroke="currentColor" stroke-width="0.8" opacity="0.5"/>
    <path d="M12 15L12 19" stroke="currentColor" stroke-width="0.8" opacity="0.5"/>
    <path d="M6.8 9L9.6 10.8" stroke="currentColor" stroke-width="0.8" opacity="0.5"/>
    <path d="M14.4 13.2L17.2 15" stroke="currentColor" stroke-width="0.8" opacity="0.5"/>
    <path d="M17.2 9L14.4 10.8" stroke="currentColor" stroke-width="0.8" opacity="0.5"/>
    <path d="M9.6 13.2L6.8 15" stroke="currentColor" stroke-width="0.8" opacity="0.5"/>
  </svg>
</template>
