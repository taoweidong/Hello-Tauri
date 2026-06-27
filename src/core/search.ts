import type { SearchMatch, SearchResults } from '@/adapters/types'

export class SearchService {
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
