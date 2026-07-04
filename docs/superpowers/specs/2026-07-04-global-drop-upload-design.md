# 全局拖拽上传设计规格

## 概述

将文件拖拽上传从左侧 ArchivePanel 的 UploadZone 扩展到整个应用窗口。用户可以将压缩包文件拖到页面任意位置触发上传，无需精确拖到左侧面板。

## 需求

1. **全局拖拽区域**：拖拽文件到应用窗口任意位置（顶部栏、左侧面板、中间工作区、右侧面板、底部栏）均可触发上传
2. **文件类型过滤**：仅接受压缩包格式（`.zip`、`.gz`、`.gzip`、`.tgz`、`.7z`、`.rar`、`.tar`），非压缩包文件拖入时给出提示
3. **视觉反馈**：拖拽文件进入窗口时显示全屏半透明遮罩 + 居中提示文字，松手后遮罩消失
4. **与现有功能共存**：左侧 UploadZone 的拖拽上传仍然可用，两者调用同一个 `addFiles()` 入口

## 架构设计

### 方案：Composable + AppLayout 集成

创建 `useGlobalDrop` composable 封装拖拽逻辑，在 `AppLayout.vue` 中调用并渲染遮罩层。

### 数据流

```
用户拖拽文件到任意位置
  → AppLayout 监听到 drop 事件
  → useGlobalDrop 过滤文件类型
  → 调用 addFiles(filteredFiles)
  → useArchiveManager 创建 ArchiveItem
  → triggerDecompress → useDecompress 解压管道
```

## 组件设计

### 1. `useGlobalDrop` composable

**文件：** `src/composables/use-global-drop.ts`

**职责：**
- 封装全局 `dragenter` / `dragover` / `dragleave` / `drop` 事件监听
- 管理 `isDragging` 响应式状态（控制遮罩显隐）
- 文件类型过滤：仅接受压缩包格式，拒绝时通过 Naive UI `useMessage` 提示
- 调用 `useArchiveManager().addFiles()` 完成上传

**接口：**

```typescript
export function useGlobalDrop() {
  const isDragging = ref(false)

  function setup(el: HTMLElement) { /* 绑定事件 */ }
  function cleanup() { /* 解绑事件 */ }

  return { isDragging, setup, cleanup }
}
```

**关键实现细节：**

- **dragCounter 防闪烁**：使用计数器，`dragenter` 时 +1，`dragleave` 时 -1，仅 `counter === 0` 时隐藏遮罩。解决拖拽经过子元素时 `dragleave` 频繁触发导致的闪烁问题。
- **阻止默认行为**：`dragover` 和 `drop` 事件中必须调用 `e.preventDefault()`，否则浏览器会直接打开文件而非触发 drop 事件。
- **文件类型检测**：通过文件扩展名判断，支持 `.zip`、`.gz`、`.gzip`、`.tgz`、`.7z`、`.rar`、`.tar`（不区分大小写）。
- **消息提示**：使用 Naive UI 的 `useMessage().warning('仅支持压缩包文件')` 提示不支持的文件类型。

### 2. AppLayout.vue 改动

**模板：** 在 `.app-shell` 内部末尾追加遮罩层：

```html
<Transition name="drop-overlay">
  <div v-if="isDragging" class="drop-overlay">
    <div class="drop-overlay-content">
      <!-- 上传图标 SVG -->
      <span>释放以上传压缩包</span>
    </div>
  </div>
</Transition>
```

**脚本：**
- 引入 `useGlobalDrop`
- 在 `onMounted` 中调用 `setup()` 绑定到 `.app-shell` 根元素
- 在 `onBeforeUnmount` 中调用 `cleanup()`

**样式（scoped）：**
- `.drop-overlay`：`position: absolute; inset: 0; z-index: 100`
- 背景：半透明深色 `rgba(0, 0, 0, 0.5)` + `backdrop-filter: blur(4px)`
- 居中内容：主色虚线边框圆角矩形 + 上传图标 + 提示文字
- `<Transition>` 实现 `opacity` 淡入淡出动画

## 边界处理

| 场景 | 处理方式 |
|------|----------|
| 拖拽经过子元素 | `dragCounter` 计数器防止遮罩闪烁 |
| 拖入非压缩包文件 | `message.warning` 提示，不添加到列表 |
| 浏览器默认打开文件 | `dragover` 和 `drop` 均 `preventDefault()` |
| 与 UploadZone 共存 | 两者都调用 `addFiles()`，互不冲突 |
| 拖拽离开窗口 | `dragCounter` 归零，遮罩自动隐藏 |

## 文件变更清单

| 文件 | 变更类型 |
|------|----------|
| `src/composables/use-global-drop.ts` | 新增 |
| `src/layout/AppLayout.vue` | 修改（引入 composable + 遮罩模板 + 样式） |
