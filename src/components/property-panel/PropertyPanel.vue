<script setup lang="ts">
import { NScrollbar } from 'naive-ui'
import MetadataView from './MetadataView.vue'
import ConfigForm from './ConfigForm.vue'
import PathBreadcrumb from './PathBreadcrumb.vue'
</script>

<template>
  <NScrollbar>
    <MetadataView />
    <ConfigForm />
    <PathBreadcrumb />
  </NScrollbar>
</template>
