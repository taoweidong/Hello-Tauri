<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import { NInput, NButton, NSpace, NTag } from 'naive-ui'
import { useSearch } from '@/composables/use-search'
import { useTabManager } from '@/composables/use-tabs'
import { extractSearchableText } from '@/core/search'
import type { SearchMatch } from '@/types'

const keyword = ref('')
const { search, searching, results, clear } = useSearch()
const { tabs, activateTab } = useTabManager()

/** 搜索输入框引用，用于快捷键聚焦 */
const inputRef = ref<InstanceType<typeof NInput> | null>(null)
/** 是否展示搜索结果面板 */
const showResults = ref(false)

/** 可搜索的内容类型 */
const SEARCHABLE_TYPES = new Set(['text', 'csv', 'json', 'log'])

/** 截断后的文本片段，用于模板中高亮显示 */
interface TruncatedSegment {
  prefix: string
  match: string
  suffix: string
}

/** 按文件分组的搜索结果（含预计算的截断片段） */
const groupedResults = computed(() => {
  if (!results.value?.matches.length) return []

  const kw = keyword.value.trim()
  const matchLen = kw.length || 1
  const maxSegmentLen = 80

  /** 将匹配位置附近的文本截断并拆分为前缀/匹配/后缀三段 */
  function buildSegments(line: string, start: number): TruncatedSegment {
    const matched = line.slice(start, start + matchLen)
    const half = Math.floor((maxSegmentLen - matched.length) / 2)
    const lineStart = Math.max(0, start - half)
    const lineEnd = Math.min(line.length, start + matched.length + half)
    return {
      prefix: (lineStart > 0 ? '…' : '') + line.slice(lineStart, start),
      match: matched,
      suffix: line.slice(start + matched.length, lineEnd) + (lineEnd < line.length ? '…' : ''),
    }
  }

  const groupMap = new Map<string, {
    filePath: string
    fileName: string
    matches: (SearchMatch & { segments: TruncatedSegment })[]
  }>()

  for (const m of results.value.matches) {
    const groupKey = `${m.archiveId}:${m.filePath}`
    if (!groupMap.has(groupKey)) {
      groupMap.set(groupKey, { filePath: m.filePath, fileName: m.fileName, matches: [] })
    }
    groupMap.get(groupKey)!.matches.push({ ...m, segments: buildSegments(m.lineContent, m.matchStart) })
  }

  return Array.from(groupMap.values())
})

/** 总匹配数 */
const totalMatches = computed(() => results.value?.matches.length ?? 0)

function handleSearch() {
  const kw = keyword.value.trim()
  if (!kw) {
    clear()
    showResults.value = false
    return
  }

  // 从已打开的标签页中收集可搜索的文件内容
  const searchableFiles: { archiveId: string; filePath: string; content: string }[] = []
  for (const tab of tabs.value) {
    if (!tab.content || !SEARCHABLE_TYPES.has(tab.content.type)) continue
    const text = extractSearchableText(tab.content)
    if (text) {
      const filePath = tab.fileNode.path || tab.fileNode.label
      searchableFiles.push({ archiveId: tab.archiveId, filePath, content: text })
    }
  }
  search(searchableFiles, kw)
  showResults.value = true
}

/** 点击搜索结果，跳转到对应标签页 */
function navigateToResult(match: SearchMatch) {
  const tab = tabs.value.find(
    t => t.archiveId === match.archiveId &&
      (t.fileNode.path === match.filePath || t.fileNode.label === match.fileName)
  )
  if (tab) {
    activateTab(tab.id)
  }
  showResults.value = false
}

/** 关闭结果面板 */
function closeResults() {
  showResults.value = false
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
    showResults.value = false
  }
  // Escape 关闭结果面板
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
          placeholder="全局搜索..."
          clearable
          style="width: 240px; padding-right: 52px;"
          @keyup.enter="handleSearch"
          @focus="results && (showResults = true)"
        />
        <kbd class="absolute right-2 top-1/2 -translate-y-1/2 px-1.5 py-0.5 text-[10px] leading-none rounded bg-bg-elevated border border-border text-text-secondary pointer-events-none select-none">
          {{ shortcutLabel }}
        </kbd>
      </div>
      <NButton type="primary" :loading="searching" @click="handleSearch">
        搜索
      </NButton>
    </NSpace>

    <!-- 搜索结果下拉面板 -->
    <Transition name="results-fade">
      <div
        v-if="showResults && results"
        class="absolute top-full left-0 mt-1.5 w-[420px] max-h-[360px] overflow-y-auto rounded-lg bg-bg-surface border border-border shadow-lg z-50"
      >
        <!-- 结果统计栏 -->
        <div class="flex items-center justify-between px-3 py-2 border-b border-border/60 text-[11px] text-text-secondary sticky top-0 bg-bg-surface z-10">
          <span>
            找到 <strong class="text-text-primary">{{ totalMatches }}</strong> 个匹配
            <span v-if="results.searchTimeMs">（{{ results.searchTimeMs.toFixed(1) }}ms）</span>
          </span>
          <button class="text-text-secondary hover:text-primary cursor-pointer bg-transparent border-none text-xs" @click="closeResults">
            关闭
          </button>
        </div>

        <!-- 无结果提示 -->
        <div v-if="totalMatches === 0" class="px-3 py-6 text-center text-text-secondary text-sm">
          未找到 "{{ keyword }}" 的匹配结果
        </div>

        <!-- 按文件分组的结果 -->
        <div v-for="group in groupedResults" :key="group.filePath" class="border-b border-border/30 last:border-b-0">
          <!-- 文件头 -->
          <div class="px-3 py-1.5 bg-bg-elevated/50 text-[11px] text-text-secondary font-medium flex items-center gap-1.5 sticky top-[33px] bg-bg-surface z-[5]">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="w-3 h-3 shrink-0">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
              <polyline points="14 2 14 8 20 8"/>
            </svg>
            <span class="truncate">{{ group.fileName }}</span>
            <NTag size="tiny" :bordered="false" type="info" class="ml-auto shrink-0">{{ group.matches.length }}</NTag>
          </div>
          <!-- 匹配条目 -->
          <div
            v-for="(match, idx) in group.matches.slice(0, 20)"
            :key="idx"
            class="px-3 py-1.5 cursor-pointer hover:bg-primary/8 transition-colors text-[12px] flex items-start gap-2"
            @click="navigateToResult(match)"
          >
            <span class="text-text-secondary tabular-nums shrink-0 w-8 text-right leading-5">{{ match.lineNumber }}</span>
            <span class="text-text-primary leading-5 overflow-hidden text-ellipsis whitespace-nowrap">
              <span class="text-text-secondary">{{ match.segments.prefix }}</span><mark class="bg-primary/20 text-primary rounded-sm px-0.5 font-medium">{{ match.segments.match }}</mark><span class="text-text-secondary">{{ match.segments.suffix }}</span>
            </span>
          </div>
          <div v-if="group.matches.length > 20" class="px-3 py-1 text-[11px] text-text-secondary text-center">
            还有 {{ group.matches.length - 20 }} 个匹配项...
          </div>
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
