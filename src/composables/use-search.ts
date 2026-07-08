import { ref } from 'vue'
import { SearchService } from '@/core/search'
import type { SearchResults } from '@/types'

/** 搜索服务单例 */
const searchService = new SearchService()
/** 搜索结果（模块级单例） */
const results = ref<SearchResults | null>(null)
/** 是否正在搜索 */
const searching = ref(false)
/** 搜索版本号，用于解决竞态条件（后发起的搜索覆盖先前的结果） */
let searchId = 0

/** 搜索 composable，提供全文搜索与结果管理 */
export function useSearch() {
  /**
   * 在多个文件中搜索关键字
   * 通过版本号机制防止竞态：只有最新发起的搜索结果才会生效
   * @param files - 包含文件内容的数组
   * @param keyword - 搜索关键字
   */
  async function search(
    files: { archiveId: string; filePath: string; content: string }[],
    keyword: string
  ) {
    const currentId = ++searchId
    searching.value = true
    try {
      const result = await searchService.searchAll(files, keyword)
      // 只有当前搜索仍是最新版本时才更新结果
      if (currentId === searchId) {
        results.value = result
      }
    } finally {
      if (currentId === searchId) {
        searching.value = false
      }
    }
  }

  /** 清空搜索结果 */
  function clear() {
    results.value = null
  }

  return { results, searching, search, clear }
}
