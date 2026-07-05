import { ref } from 'vue'
import { SearchService } from '@/core/search'
import type { SearchResults } from '@/types'

/** 搜索服务单例 */
const searchService = new SearchService()
/** 搜索结果（模块级单例） */
const results = ref<SearchResults | null>(null)
/** 是否正在搜索 */
const searching = ref(false)

/** 搜索 composable，提供全文搜索与结果管理 */
export function useSearch() {
  /**
   * 在多个文件中搜索关键字
   * @param files - 包含文件内容的数组
   * @param keyword - 搜索关键字
   */
  async function search(
    files: { archiveId: string; filePath: string; content: string }[],
    keyword: string
  ) {
    searching.value = true
    try {
      results.value = await searchService.searchAll(files, keyword)
    } finally {
      searching.value = false
    }
  }

  /** 清空搜索结果 */
  function clear() {
    results.value = null
  }

  return { results, searching, search, clear }
}
