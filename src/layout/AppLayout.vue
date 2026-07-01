<script setup lang="ts">
import { ref } from 'vue'
import {
  NLayout, NLayoutHeader, NLayoutSider, NLayoutContent,
} from 'naive-ui'
import { useAppStore } from '@/stores/app'
import PublicBar from '@/components/public-bar/PublicBar.vue'
import ArchivePanel from '@/components/archive-panel/ArchivePanel.vue'
import Workspace from '@/components/workspace/Workspace.vue'
import PropertyPanel from '@/components/property-panel/PropertyPanel.vue'

const store = useAppStore()
const leftCollapsed = ref(false)
const rightCollapsed = ref(false)
</script>

<template>
  <NLayout position="absolute" has-sider>
    <NLayoutHeader bordered style="height: 64px; padding: 0 16px;">
      <PublicBar />
    </NLayoutHeader>

    <NLayout has-sider position="absolute" style="top: 64px;">
      <NLayoutSider
        bordered
        :width="store.leftPanelWidth"
        :collapsed-width="0"
        collapse-mode="width"
        v-model:collapsed="leftCollapsed"
        show-trigger="bar"
        content-style="padding: 8px;"
      >
        <ArchivePanel />
      </NLayoutSider>

      <NLayoutContent content-style="padding: 0;">
        <Workspace />
      </NLayoutContent>

      <NLayoutSider
        bordered
        :width="store.rightPanelWidth"
        :collapsed-width="0"
        collapse-mode="width"
        v-model:collapsed="rightCollapsed"
        show-trigger="bar"
        content-style="padding: 8px;"
      >
        <PropertyPanel />
      </NLayoutSider>
    </NLayout>
  </NLayout>
</template>
