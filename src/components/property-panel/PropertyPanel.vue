<script setup lang="ts">
import { NScrollbar } from 'naive-ui'
import MetadataView from './MetadataView.vue'
import ConfigForm from './ConfigForm.vue'
import PathBreadcrumb from './PathBreadcrumb.vue'
</script>

<template>
  <div style="height: 100%;">
    <NScrollbar style="height: 100%;">
      <MetadataView />
      <ConfigForm />
      <PathBreadcrumb />
    </NScrollbar>
  </div>
</template>
