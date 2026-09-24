<script setup lang="ts">
import { useAppStore } from '@/stores/app'
import { IconBox, IconLayers, IconSliders, IconDatabase } from '@/components/icons'

const appStore = useAppStore()

const stack = [
  { name: '前端框架', value: 'Vue 3 + TypeScript + Vite' },
  { name: 'UI 组件库', value: 'Element Plus' },
  { name: '状态管理', value: 'Pinia' },
  { name: '桌面容器', value: 'Tauri 2（Rust 桥接）' },
  { name: '业务逻辑', value: '全部 TypeScript 实现' },
  { name: '运行依赖', value: '无外部网络与在线资源' },
]

const structure = [
  { path: 'src/', desc: '前端源码，承载全部业务逻辑', icon: IconLayers },
  { path: 'src/api/', desc: '桥接层，屏蔽桌面与浏览器差异', icon: IconSliders },
  { path: 'src/stores/', desc: 'Pinia 状态与业务规则', icon: IconDatabase },
  { path: 'src/views/', desc: '四个功能页面', icon: IconLayers },
  { path: 'src-tauri/', desc: 'Rust 薄桥接层，仅窗口与存储读写', icon: IconBox },
  { path: 'scripts/', desc: '一键打包脚本', icon: IconSliders },
]
</script>

<template>
  <div class="page">
    <div class="page-title">
      <h1>关于</h1>
      <span class="caption">版本信息与技术构成</span>
    </div>

    <div class="cols">
      <section class="ht-card">
        <header class="ht-card__head">应用信息</header>
        <dl class="kv">
          <dt>应用名称</dt>
          <dd>{{ appStore.settings.title || appStore.info?.name || 'Hello-Tauri' }}</dd>
          <dt>描述</dt>
          <dd>{{ appStore.settings.description || '-' }}</dd>
          <dt>版本</dt>
          <dd class="num">v{{ appStore.info?.version ?? '0.1.0' }}</dd>
          <dt>Tauri</dt>
          <dd class="num">{{ appStore.info?.tauriVersion ?? '-' }}</dd>
          <dt>系统平台</dt>
          <dd>{{ appStore.info?.platform ?? '-' }}</dd>
          <dt>处理器架构</dt>
          <dd>{{ appStore.info?.arch ?? '-' }}</dd>
        </dl>
        <div class="hero">
          <span class="hero__badge">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6L9 17l-5-5" /></svg>
          </span>
          <div>
            <p class="hero__title">单文件绿色版</p>
            <p class="hero__text">打包产物为单个 exe，复制到任意 Windows 机器即可运行，无需安装 Node.js、Rust 或 VC++ 运行库。</p>
          </div>
        </div>
      </section>

      <section class="ht-card">
        <header class="ht-card__head">技术栈</header>
        <dl class="kv">
          <template v-for="item in stack" :key="item.name">
            <dt>{{ item.name }}</dt>
            <dd>{{ item.value }}</dd>
          </template>
        </dl>
      </section>
    </div>

    <section class="ht-card">
      <header class="ht-card__head">目录结构</header>
      <ul class="tree">
        <li v-for="item in structure" :key="item.path" class="tree__row">
          <component :is="item.icon" class="tree__icon" />
          <span class="tree__path mono">{{ item.path }}</span>
          <span class="tree__desc">{{ item.desc }}</span>
        </li>
      </ul>
    </section>
  </div>
</template>

<style scoped>
.cols {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 14px;
  align-items: start;
}

@media (max-width: 860px) {
  .cols {
    grid-template-columns: 1fr;
  }
}

.kv {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  gap: 0;
  margin: 0;
  padding: 6px 0;
}

.kv dt {
  padding: 8px 16px;
  font-size: 12px;
  color: var(--ht-text-3);
  white-space: nowrap;
}

.kv dd {
  padding: 8px 16px 8px 0;
  margin: 0;
  font-size: 12.5px;
  color: var(--ht-text-1);
  text-align: right;
  overflow-wrap: anywhere;
}

.kv > dt:not(:first-of-type),
.kv > dd:not(:first-of-type) {
  border-top: 1px solid var(--ht-line);
}

.hero {
  display: flex;
  gap: 12px;
  align-items: flex-start;
  padding: 14px 16px;
  border-top: 1px solid var(--ht-line);
  background: var(--ht-primary-soft);
}

.hero__badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border-radius: 8px;
  background: var(--ht-primary);
  color: #fff;
  flex-shrink: 0;
}

.hero__title {
  margin: 0 0 2px;
  font-size: 13px;
  font-weight: 600;
  color: var(--ht-text-1);
}

.hero__text {
  margin: 0;
  font-size: 12px;
  line-height: 1.7;
  color: var(--ht-text-2);
}

.tree {
  list-style: none;
  margin: 0;
  padding: 6px 0;
}

.tree__row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 9px 16px;
  font-size: 12.5px;
}

.tree__row + .tree__row {
  border-top: 1px solid var(--ht-line);
}

.tree__icon {
  width: 15px;
  height: 15px;
  color: var(--ht-text-3);
  flex-shrink: 0;
}

.tree__path {
  min-width: 118px;
  color: var(--ht-primary);
  font-size: 12.5px;
  word-break: break-all;
}

.tree__desc {
  color: var(--ht-text-2);
}

@media (max-width: 640px) {
  .tree__row {
    flex-wrap: wrap;
    gap: 6px 12px;
  }

  .tree__path {
    min-width: 0;
  }

  .tree__desc {
    flex-basis: 100%;
    padding-left: 27px;
  }
}
</style>