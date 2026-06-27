<script setup lang="ts">
import { Splitpanes, Pane } from 'splitpanes'
</script>

<template>
  <Splitpanes style="height: 100%;">
    <Pane min-size="20">
      <slot name="left" />
    </Pane>
    <Pane min-size="20">
      <slot name="right" />
    </Pane>
  </Splitpanes>
</template>
