<script setup lang="ts">
/**
 * 全局搜索组件
 * 提供归档文件名搜索、快捷键聚焦、结果高亮与标签页跳转能力
 */
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue'
import { NInput, NButton, NSpace } from 'naive-ui'
import { useArchiveManager } from '@/composables/use-archives'
import { useTabManager } from '@/composables/use-tabs'
import { FileTreeBuilder } from '@/core/file-tree'
import type { FileTreeNode } from '@/types'

const keyword = ref('')
const { archives } = useArchiveManager()
const { openTab, tabs, activateTab } = useTabManager()

/** 搜索输入框引用，用于快捷键聚焦 */
const inputRef = ref<InstanceType<typeof NInput> | null>(null)
/** 是否展示搜索结果面板 */
const showResults = ref(false)

/** 单条文件搜索结果 */
interface FileSearchResult {
  /** 归档 id */
  archiveId: string
  /** 归档名称 */
  archiveName: string
  /** 文件树节点（用于打开标签页） */
  node: FileTreeNode
  /** 文件名 */
  fileName: string
  /** 文件路径 */
  filePath: string
  /** 是否已在标签页中打开 */
  alreadyOpen: boolean
}

/** 搜索耗时（毫秒） */
const searchTimeMs = ref(0)

/** 搜索结果（改为 watch + 防抖，避免每次按键触发全量计算） */
const searchResults = ref<FileSearchResult[]>([])

/** 防抖定时器 */
let searchTimer: ReturnType<typeof setTimeout> | null = null

/**
 * 从所有已解压归档中搜索文件名，带 300ms 防抖
 */
function doSearch(kw: string) {
  if (searchTimer) clearTimeout(searchTimer)
  const trimmed = kw.trim()
  if (!trimmed) {
    searchResults.value = []
    searchTimeMs.value = 0
    return
  }
  searchTimer = setTimeout(() => {
    const query = trimmed.toLowerCase()
    const start = performance.now()
    const results: FileSearchResult[] = []

    for (const archive of archives.value) {
      if (archive.status !== 'completed') continue
      const allNodes = FileTreeBuilder.flattenTree(archive.files)
      for (const node of allNodes) {
        if (!node.isLeaf) continue
        const fileName = node.label.toLowerCase()
        const filePath = (node.path || node.label).toLowerCase()
        if (fileName.includes(query) || filePath.includes(query)) {
          results.push({
            archiveId: archive.id,
            archiveName: archive.name,
            node,
            fileName: node.label,
            filePath: node.path || node.label,
            alreadyOpen: tabs.value.some(
              t => t.archiveId === archive.id && t.fileNode.key === node.key
            ),
          })
        }
      }
    }

    searchTimeMs.value = performance.now() - start
    searchResults.value = results
  }, 300)
}

/** 总匹配数 */
const totalMatches = computed(() => searchResults.value.length)

/** 输入时触发防抖搜索 */
watch(keyword, (val) => {
  showResults.value = val.trim().length > 0
  doSearch(val)
})

/**
 * 点击搜索结果，打开对应文件的标签页。
 * 若标签页已存在则直接激活。
 */
function navigateToResult(result: FileSearchResult) {
  const existing = tabs.value.find(
    t => t.archiveId === result.archiveId && t.fileNode.key === result.node.key
  )
  if (existing) {
    activateTab(existing.id)
  } else {
    openTab(result.node, result.archiveId)
  }
  showResults.value = false
  keyword.value = ''
}

/** 关闭结果面板 */
function closeResults() {
  showResults.value = false
}

/** 高亮文件名中匹配关键字的段落 */
function highlightMatch(text: string): { before: string; match: string; after: string } {
  const kw = keyword.value.trim()
  if (!kw) return { before: text, match: '', after: '' }
  const idx = text.toLowerCase().indexOf(kw.toLowerCase())
  if (idx === -1) return { before: text, match: '', after: '' }
  return {
    before: text.slice(0, idx),
    match: text.slice(idx, idx + kw.length),
    after: text.slice(idx + kw.length),
  }
}

/** 从文件路径中提取目录部分（用于结果显示） */
function getDirPath(filePath: string): string {
  const idx = filePath.lastIndexOf('/')
  if (idx === -1) return ''
  return filePath.slice(0, idx + 1)
}

/** 检测操作系统以显示正确的快捷键修饰符 */
const isMac = typeof navigator !== 'undefined' && /Mac/.test(navigator.userAgent)
const shortcutLabel = isMac ? '⌘K' : 'Ctrl+K'

/**
 * 全局快捷键监听：拦截 Ctrl+K / Cmd+K / Ctrl+F / Cmd+F，
 * 阻止浏览器默认搜索行为，聚焦到应用内搜索输入框
 */
function handleGlobalKeydown(e: KeyboardEvent) {
  const isMod = isMac ? e.metaKey : e.ctrlKey
  if (isMod && (e.key === 'k' || e.key === 'K' || e.key === 'f' || e.key === 'F')) {
    e.preventDefault()
    e.stopPropagation()
    const inputEl = inputRef.value?.$el?.querySelector('input') as HTMLInputElement | null
    if (inputEl) {
      inputEl.focus()
      inputEl.select()
    }
  }
  if (e.key === 'Escape' && showResults.value) {
    e.preventDefault()
    showResults.value = false
  }
}

/** 点击外部关闭结果面板 */
function handleClickOutside(e: MouseEvent) {
  const el = (e.target as HTMLElement)?.closest?.('.global-search-wrapper')
  if (!el) showResults.value = false
}

onMounted(() => {
  document.addEventListener('keydown', handleGlobalKeydown, true)
  document.addEventListener('click', handleClickOutside)
})
onBeforeUnmount(() => {
  document.removeEventListener('keydown', handleGlobalKeydown, true)
  document.removeEventListener('click', handleClickOutside)
})
</script>

<template>
  <div class="global-search-wrapper relative">
    <NSpace align="center" :size="8">
      <div class="relative">
        <NInput
          ref="inputRef"
          v-model:value="keyword"
          type="text"
          placeholder="搜索文件名..."
          clearable
          style="width: 240px; padding-right: 52px;"
          @focus="keyword.trim() && (showResults = true)"
        />
        <kbd class="absolute right-2 top-1/2 -translate-y-1/2 px-1.5 py-0.5 text-[11px] leading-none rounded bg-bg-elevated border border-border text-text-secondary pointer-events-none select-none">
          {{ shortcutLabel }}
        </kbd>
      </div>
      <NButton type="primary" @click="showResults = keyword.trim().length > 0">
        搜索
      </NButton>
    </NSpace>

    <!-- 搜索结果下拉面板 -->
    <Transition name="results-fade">
      <div
        v-if="showResults && keyword.trim()"
        class="absolute top-full left-0 mt-1.5 w-[420px] max-w-[calc(100vw-32px)] max-h-[400px] overflow-y-auto rounded-lg bg-bg-surface border border-border shadow-lg z-50"
      >
        <!-- 结果统计栏 -->
        <div class="flex items-center justify-between px-3 py-2 border-b border-border/60 text-[12px] text-text-secondary sticky top-0 bg-bg-surface z-10">
          <span>
            找到 <strong class="text-text-primary">{{ totalMatches }}</strong> 个文件
            <span v-if="searchTimeMs">（{{ searchTimeMs.toFixed(1) }}ms）</span>
          </span>
          <button class="text-text-secondary hover:text-primary cursor-pointer bg-transparent border-none text-xs" @click="closeResults">
            关闭
          </button>
        </div>

        <!-- 无结果提示 -->
        <div v-if="totalMatches === 0" class="px-3 py-6 text-center text-text-secondary text-sm">
          未找到包含 "{{ keyword }}" 的文件
        </div>

        <!-- 文件列表 -->
        <div
          v-for="(result, idx) in searchResults.slice(0, 50)"
          :key="idx"
          class="px-3 py-2 cursor-pointer hover:bg-primary/8 transition-colors border-b border-border/20 last:border-b-0 flex items-center gap-2.5"
          @click="navigateToResult(result)"
        >
          <!-- 文件图标 -->
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="w-4 h-4 shrink-0 text-text-secondary">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
            <polyline points="14 2 14 8 20 8"/>
          </svg>

          <!-- 文件名 + 路径 -->
          <div class="flex-1 min-w-0">
            <div class="text-[13px] text-text-primary leading-tight truncate font-medium">
              <span>{{ highlightMatch(result.fileName).before }}</span><mark class="bg-primary/20 text-primary rounded-sm px-0.5">{{ highlightMatch(result.fileName).match }}</mark><span>{{ highlightMatch(result.fileName).after }}</span>
              <span v-if="result.alreadyOpen" class="ml-1.5 text-[11px] text-primary/60">已打开</span>
            </div>
            <div class="text-[11px] text-text-secondary leading-tight truncate mt-0.5">
              {{ getDirPath(result.filePath) || '/' }}
            </div>
          </div>

          <!-- 归档来源标签 -->
          <span class="text-[11px] text-text-secondary shrink-0 bg-bg-elevated px-1.5 py-0.5 rounded max-w-[100px] truncate">
            {{ result.archiveName }}
          </span>
        </div>

        <!-- 截断提示 -->
        <div v-if="totalMatches > 50" class="px-3 py-2 text-[12px] text-text-secondary text-center border-t border-border/30">
          仅显示前 50 个结果，共 {{ totalMatches }} 个
        </div>
      </div>
    </Transition>
  </div>
</template>

<style scoped>
.results-fade-enter-active,
.results-fade-leave-active {
  transition: opacity 0.15s ease, transform 0.15s ease;
}
.results-fade-enter-from,
.results-fade-leave-to {
  opacity: 0;
  transform: translateY(-4px);
}
</style>
