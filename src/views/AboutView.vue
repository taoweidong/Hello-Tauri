<script setup lang="ts">
import { useAppStore } from '@/stores/app'

const appStore = useAppStore()

const stack = [
  { name: '前端框架', value: 'Vue 3 + TypeScript + Vite' },
  { name: 'UI 组件库', value: 'Element Plus' },
  { name: '状态管理', value: 'Pinia' },
  { name: '桌面容器', value: 'Tauri 2（Rust）' },
  { name: '业务逻辑', value: '全部由 TypeScript 实现' },
  { name: '运行依赖', value: '无外部网络与在线资源依赖' },
]

const structure = [
  { path: 'src/', desc: '前端源码，承载全部业务逻辑' },
  { path: 'src/api/', desc: '桥接层，屏蔽桌面与浏览器差异' },
  { path: 'src/stores/', desc: 'Pinia 状态与业务规则' },
  { path: 'src/views/', desc: '四个功能页面' },
  { path: 'src-tauri/', desc: 'Rust 薄桥接层，仅窗口与配置读写' },
  { path: 'scripts/', desc: '一键打包脚本' },
]
</script>

<template>
  <div class="page">
    <el-row :gutter="16">
      <el-col :xs="24" :md="12">
        <el-card shadow="never">
          <template #header>应用信息</template>
          <el-descriptions :column="1" border size="small">
            <el-descriptions-item label="应用名称">{{ appStore.info?.name ?? 'Hello-Tauri' }}</el-descriptions-item>
            <el-descriptions-item label="版本">{{ appStore.info?.version ?? '-' }}</el-descriptions-item>
            <el-descriptions-item label="Tauri">{{ appStore.info?.tauriVersion ?? '-' }}</el-descriptions-item>
            <el-descriptions-item label="系统平台">{{ appStore.info?.platform ?? '-' }}</el-descriptions-item>
            <el-descriptions-item label="处理器架构">{{ appStore.info?.arch ?? '-' }}</el-descriptions-item>
          </el-descriptions>
          <el-alert
            class="about__alert"
            type="success"
            :closable="false"
            show-icon
            title="单文件绿色版"
            description="打包产物为单个 exe，复制到任意 Windows 机器即可运行，无需安装 Node.js 与 Rust。"
          />
        </el-card>
      </el-col>

      <el-col :xs="24" :md="12">
        <el-card shadow="never" class="about__side">
          <template #header>技术栈</template>
          <el-descriptions :column="1" border size="small">
            <el-descriptions-item v-for="item in stack" :key="item.name" :label="item.name">
              {{ item.value }}
            </el-descriptions-item>
          </el-descriptions>
        </el-card>
      </el-col>
    </el-row>

    <el-row :gutter="16" class="about__row">
      <el-col :span="24">
        <el-card shadow="never">
          <template #header>目录结构</template>
          <el-table :data="structure" size="small" border>
            <el-table-column prop="path" label="路径" width="200" />
            <el-table-column prop="desc" label="说明" />
          </el-table>
        </el-card>
      </el-col>
    </el-row>
  </div>
</template>

<style scoped>
.about__side {
  height: 100%;
}

.about__row {
  margin-top: 16px;
}

.about__alert {
  margin-top: 12px;
}
</style>
