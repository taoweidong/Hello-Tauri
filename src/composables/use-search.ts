import { ref } from 'vue'
import { SearchService } from '@/core/search'
import type { SearchResults } from '@/types'

const searchService = new SearchService()
const results = ref<SearchResults | null>(null)
const searching = ref(false)

export function useSearch() {
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

  function clear() {
    results.value = null
  }

  return { results, searching, search, clear }
}
