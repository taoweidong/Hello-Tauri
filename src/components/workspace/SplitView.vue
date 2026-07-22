<script setup lang="ts">
/**
 * 可拖拽分栏视图
 * 基于 splitpanes 实现左右 60/40 分栏，用于表格+树形详情联动展示
 */
import { Splitpanes, Pane } from 'splitpanes'
</script>

<template>
  <Splitpanes style="height: 100%;">
    <Pane :size="60" :min-size="30">
      <slot name="left" />
    </Pane>
    <Pane :size="40" :min-size="20">
      <slot name="right" />
    </Pane>
  </Splitpanes>
</template>
