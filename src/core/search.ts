import type { ParsedContent, SearchMatch, SearchResults } from '@/types'

/**
 * 将已解析的文件内容转换为可搜索的纯文本
 * @param content - 已解析的文件内容（联合类型，按 type 分支处理）
 * @returns 纯文本字符串；不支持的类型返回空串
 */
export function extractSearchableText(content: ParsedContent): string {
  switch (content.type) {
    case 'text':
      return content.data
    case 'csv':
      return [content.data.headers.join(','), ...content.data.rows.map(row => row.join(','))].join('\n')
    case 'json':
      return typeof content.data === 'string' ? content.data : JSON.stringify(content.data, null, 2)
    case 'log':
      return content.data.map(line => line.raw).join('\n')
    default:
      return ''
  }
}

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
  searchAll(
    files: { archiveId: string; filePath: string; content: string }[],
    keyword: string
  ): SearchResults {
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
