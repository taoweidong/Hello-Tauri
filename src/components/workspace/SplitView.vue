<script setup lang="ts">
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
