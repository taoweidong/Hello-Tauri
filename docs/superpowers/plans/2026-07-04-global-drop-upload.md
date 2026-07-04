# 全局拖拽上传实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将文件拖拽上传从左侧 ArchivePanel 扩展到整个应用窗口，拖拽到任意位置即可上传压缩包。

**Architecture:** 创建 `useGlobalDrop` composable 封装原生拖拽事件监听和文件过滤逻辑，在 `AppLayout.vue` 中调用并渲染全屏半透明遮罩层作为视觉反馈。遮罩使用 `position: absolute; inset: 0; z-index: 100` 覆盖整个 `.app-shell`。

**Tech Stack:** Vue 3 Composition API、原生 Drag & Drop API、Naive UI `useMessage`

---

## 文件结构

| 文件 | 操作 | 职责 |
|------|------|------|
| `src/composables/use-global-drop.ts` | 新建 | 全局拖拽事件监听、文件过滤、`isDragging` 状态管理 |
| `src/layout/AppLayout.vue` | 修改 | 引入 composable、添加遮罩模板和样式 |
| `src/__tests__/composables/use-global-drop.test.ts` | 新建 | composable 单元测试 |

---

### Task 1: 编写 useGlobalDrop 单元测试

**Files:**
- Create: `src/__tests__/composables/use-global-drop.test.ts`

- [ ] **Step 1: 编写测试文件**

```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useGlobalDrop } from '@/composables/use-global-drop'

// 模拟 useArchiveManager
vi.mock('@/composables/use-archives', () => ({
  useArchiveManager: () => ({
    addFiles: vi.fn(),
  }),
}))

// 模拟 Naive UI useMessage
vi.mock('naive-ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('naive-ui')>()
  return {
    ...actual,
    useMessage: () => ({
      warning: vi.fn(),
    }),
  }
})

describe('useGlobalDrop', () => {
  let composable: ReturnType<typeof useGlobalDrop>
  let el: HTMLDivElement

  beforeEach(() => {
    composable = useGlobalDrop()
    el = document.createElement('div')
    document.body.appendChild(el)
    composable.setup(el)
  })

  // 清理
  afterEach(() => {
    composable.cleanup()
    document.body.removeChild(el)
  })

  it('初始状态 isDragging 为 false', () => {
    expect(composable.isDragging.value).toBe(false)
  })

  it('dragenter 后 isDragging 变为 true', () => {
    const dt = new DataTransfer()
    dt.items.add(new File(['test'], 'test.zip', { type: 'application/zip' }))
    el.dispatchEvent(new DragEvent('dragenter', { dataTransfer: dt, bubbles: true }))
    expect(composable.isDragging.value).toBe(true)
  })

  it('dragenter 后 dragleave 恢复 false', () => {
    const dt = new DataTransfer()
    dt.items.add(new File(['test'], 'test.zip', { type: 'application/zip' }))
    el.dispatchEvent(new DragEvent('dragenter', { dataTransfer: dt, bubbles: true }))
    expect(composable.isDragging.value).toBe(true)
    el.dispatchEvent(new DragEvent('dragleave', { dataTransfer: dt, bubbles: true }))
    expect(composable.isDragging.value).toBe(false)
  })

  it('drop 压缩包文件后调用 addFiles', async () => {
    const { useArchiveManager } = await import('@/composables/use-archives')
    const addFiles = vi.fn()
    vi.mocked(useArchiveManager).mockReturnValueOnce({ addFiles } as any)

    const dt = new DataTransfer()
    dt.items.add(new File(['data'], 'archive.zip', { type: 'application/zip' }))
    const dropEvent = new DragEvent('drop', { dataTransfer: dt, bubbles: true })
    el.dispatchEvent(dropEvent)

    expect(addFiles).toHaveBeenCalledTimes(1)
    expect(addFiles).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ name: 'archive.zip' })])
    )
  })

  it('drop 非压缩包文件不调用 addFiles，且提示 warning', async () => {
    const { useMessage } = await import('naive-ui')
    const warning = vi.fn()
    vi.mocked(useMessage).mockReturnValueOnce({ warning } as any)

    const { useArchiveManager } = await import('@/composables/use-archives')
    const addFiles = vi.fn()
    vi.mocked(useArchiveManager).mockReturnValueOnce({ addFiles } as any)

    const dt = new DataTransfer()
    dt.items.add(new File(['data'], 'readme.txt', { type: 'text/plain' }))
    const dropEvent = new DragEvent('drop', { dataTransfer: dt, bubbles: true })
    el.dispatchEvent(dropEvent)

    expect(addFiles).not.toHaveBeenCalled()
    expect(warning).toHaveBeenCalledWith('仅支持压缩包文件')
  })

  it('cleanup 后事件不再触发', () => {
    composable.cleanup()
    const dt = new DataTransfer()
    dt.items.add(new File(['test'], 'test.zip', { type: 'application/zip' }))
    el.dispatchEvent(new DragEvent('dragenter', { dataTransfer: dt, bubbles: true }))
    expect(composable.isDragging.value).toBe(false)
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run src/__tests__/composables/use-global-drop.test.ts`
Expected: FAIL — 模块 `@/composables/use-global-drop` 不存在

- [ ] **Step 3: 提交**

```bash
git add src/__tests__/composables/use-global-drop.test.ts
git commit -m "测试：添加 useGlobalDrop composable 单元测试"
```

---

### Task 2: 实现 useGlobalDrop composable

**Files:**
- Create: `src/composables/use-global-drop.ts`

- [ ] **Step 1: 编写 composable 实现**

```typescript
import { ref } from 'vue'
import { useMessage } from 'naive-ui'
import { useArchiveManager } from '@/composables/use-archives'

/** 支持的压缩包扩展名（小写） */
const ACCEPTED_EXTENSIONS = new Set([
  '.zip', '.gz', '.gzip', '.tgz', '.7z', '.rar', '.tar',
])

/** 判断文件是否为支持的压缩包格式 */
function isArchiveFile(fileName: string): boolean {
  const ext = fileName.slice(fileName.lastIndexOf('.')).toLowerCase()
  return ACCEPTED_EXTENSIONS.has(ext)
}

export function useGlobalDrop() {
  const isDragging = ref(false)
  const message = useMessage()
  const { addFiles } = useArchiveManager()

  let dragCounter = 0
  let boundEl: HTMLElement | null = null

  function onDragEnter(e: DragEvent) {
    e.preventDefault()
    dragCounter++
    if (e.dataTransfer?.types.includes('Files')) {
      isDragging.value = true
    }
  }

  function onDragOver(e: DragEvent) {
    e.preventDefault()
    if (e.dataTransfer) {
      e.dataTransfer.dropEffect = 'copy'
    }
  }

  function onDragLeave(_e: DragEvent) {
    dragCounter--
    if (dragCounter <= 0) {
      dragCounter = 0
      isDragging.value = false
    }
  }

  function onDrop(e: DragEvent) {
    e.preventDefault()
    dragCounter = 0
    isDragging.value = false

    const files = Array.from(e.dataTransfer?.files ?? [])
    if (files.length === 0) return

    const archives = files.filter(f => isArchiveFile(f.name))
    if (archives.length === 0) {
      message.warning('仅支持压缩包文件')
      return
    }

    if (archives.length < files.length) {
      message.warning(`已忽略 ${files.length - archives.length} 个非压缩包文件`)
    }

    addFiles(archives)
  }

  function setup(el: HTMLElement) {
    boundEl = el
    el.addEventListener('dragenter', onDragEnter)
    el.addEventListener('dragover', onDragOver)
    el.addEventListener('dragleave', onDragLeave)
    el.addEventListener('drop', onDrop)
  }

  function cleanup() {
    if (!boundEl) return
    boundEl.removeEventListener('dragenter', onDragEnter)
    boundEl.removeEventListener('dragover', onDragOver)
    boundEl.removeEventListener('dragleave', onDragLeave)
    boundEl.removeEventListener('drop', onDrop)
    boundEl = null
    dragCounter = 0
    isDragging.value = false
  }

  return { isDragging, setup, cleanup }
}
```

- [ ] **Step 2: 运行测试确认通过**

Run: `npx vitest run src/__tests__/composables/use-global-drop.test.ts`
Expected: 所有测试 PASS

- [ ] **Step 3: 提交**

```bash
git add src/composables/use-global-drop.ts
git commit -m "功能：实现 useGlobalDrop composable（全局拖拽事件监听与文件过滤）"
```

---

### Task 3: 在 AppLayout.vue 中集成遮罩层

**Files:**
- Modify: `src/layout/AppLayout.vue`

- [ ] **Step 1: 修改 `<script setup>` 部分**

在现有 import 之后添加：

```typescript
import { useGlobalDrop } from '@/composables/use-global-drop'
```

在 `rightCollapsed` 声明之后添加：

```typescript
// ── 全局拖拽上传 ──
const { isDragging, setup: setupDrop, cleanup: cleanupDrop } = useGlobalDrop()
const appShellRef = ref<HTMLElement | null>(null)
```

修改已有的 `onMounted` 回调，追加 `setupDrop` 调用：

```typescript
onMounted(() => {
  timer = setInterval(() => { now.value = new Date() }, 1000)
  if (appShellRef.value) setupDrop(appShellRef.value)
})
```

修改已有的 `onBeforeUnmount` 回调，追加 `cleanupDrop` 调用：

```typescript
onBeforeUnmount(() => {
  clearInterval(timer)
  cleanupDrop()
})
```

- [ ] **Step 2: 修改 `<template>` 部分**

在 `.app-shell` 的 `<div>` 上添加 `ref="appShellRef"`：

```html
<div ref="appShellRef" class="app-shell" :data-theme="store.isDarkTheme ? 'dark' : 'light'">
```

在 `</footer>` 之后、`</div>` (app-shell 关闭标签) 之前插入遮罩层：

```html
    <!-- ── 全局拖拽上传遮罩 ── -->
    <Transition name="drop-overlay">
      <div v-if="isDragging" class="drop-overlay">
        <div class="drop-overlay-content">
          <svg class="drop-overlay-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor"
               stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
            <polyline points="17 8 12 3 7 8"/>
            <line x1="12" y1="3" x2="12" y2="15"/>
          </svg>
          <span class="drop-overlay-text">释放以上传压缩包</span>
        </div>
      </div>
    </Transition>
```

- [ ] **Step 3: 在 `<style scoped>` 末尾追加遮罩层样式**

在最后一个 `}` (滚动条美化规则) 之后追加：

```css
/* ══════════════════════════════════════
   全局拖拽上传遮罩
   ══════════════════════════════════════ */
.drop-overlay {
  position: absolute;
  inset: 0;
  z-index: 100;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.5);
  backdrop-filter: blur(4px);
  pointer-events: none;
}

.drop-overlay-content {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 16px;
  padding: 40px 56px;
  border: 2px dashed var(--primary);
  border-radius: 16px;
  background: var(--primary-soft);
  color: var(--primary);
}

.drop-overlay-icon {
  width: 48px;
  height: 48px;
}

.drop-overlay-text {
  font-size: 16px;
  font-weight: 600;
  letter-spacing: 0.5px;
}

/* 遮罩淡入淡出动画 */
.drop-overlay-enter-active,
.drop-overlay-leave-active {
  transition: opacity 0.2s ease;
}
.drop-overlay-enter-from,
.drop-overlay-leave-to {
  opacity: 0;
}
```

- [ ] **Step 4: 运行类型检查**

Run: `npm run typecheck`
Expected: 无错误

- [ ] **Step 5: 运行全部测试**

Run: `npm test`
Expected: 所有测试 PASS

- [ ] **Step 6: 提交**

```bash
git add src/layout/AppLayout.vue
git commit -m "功能：AppLayout 集成全局拖拽上传遮罩层"
```

---

### Task 4: 手动验证

- [ ] **Step 1: 启动开发服务器**

Run: `npm run dev`

- [ ] **Step 2: 验证拖拽压缩包**

将 `.zip` 文件拖到页面中间工作区 → 应看到半透明遮罩 + "释放以上传压缩包"提示，松手后遮罩消失，左侧面板出现新压缩包卡片。

- [ ] **Step 3: 验证拖拽非压缩包**

将 `.txt` 文件拖到页面 → 应看到遮罩，松手后弹出 warning 提示"仅支持压缩包文件"，左侧无新增。

- [ ] **Step 4: 验证左侧原有 UploadZone 仍可用**

在左侧面板的 UploadZone 区域拖拽压缩包 → 功能正常。

- [ ] **Step 5: 验证拖拽离开窗口**

将文件拖入窗口后拖出 → 遮罩应自动消失。
