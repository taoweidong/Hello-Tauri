import type { SearchMatch, SearchResults } from '@/types'

/** 全文搜索服务，支持在多个文件内容中查找关键字 */
export class SearchService {
  /**
   * 在单段文本中搜索关键字，返回所有匹配项
   * @param text - 待搜索的文本内容
   * @param keyword - 搜索关键字
   * @param filePath - 文件路径（用于结果标识）
   * @param archiveId - 所属归档 id
   * @returns 匹配项数组
   */
  searchInText(text: string, keyword: string, filePath: string, archiveId: string): SearchMatch[] {
    if (!keyword) return []
    const matches: SearchMatch[] = []
    const lines = text.split('\n')
    const lowerKeyword = keyword.toLowerCase()

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      const lowerLine = line.toLowerCase()
      let pos = 0
      while ((pos = lowerLine.indexOf(lowerKeyword, pos)) !== -1) {
        matches.push({
          archiveId,
          filePath,
          fileName: filePath.split('/').pop() ?? filePath,
          lineNumber: i + 1,
          lineContent: line,
          matchStart: pos,
          matchEnd: pos + keyword.length,
        })
        pos += keyword.length
      }
    }
    return matches
  }

  /**
   * 在多个文件中搜索关键字，返回汇总结果
   * @param files - 包含文件内容的数组
   * @param keyword - 搜索关键字
   * @returns 搜索结果（含耗时统计）
   */
  async searchAll(
    files: { archiveId: string; filePath: string; content: string }[],
    keyword: string
  ): Promise<SearchResults> {
    const start = performance.now()
    const allMatches: SearchMatch[] = []

    for (const file of files) {
      const matches = this.searchInText(file.content, keyword, file.filePath, file.archiveId)
      allMatches.push(...matches)
    }

    return {
      keyword,
      matches: allMatches,
      searchTimeMs: performance.now() - start,
    }
  }
}
