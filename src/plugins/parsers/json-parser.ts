import type { ParsedResult } from '@/plugins/types'

export function parseJson(text: string): ParsedResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    try {
      parsed = text.split('\n').filter(l => l.trim()).map(line => JSON.parse(line))
    } catch (err) {
      throw new Error(`Invalid JSON: ${err instanceof Error ? err.message : 'parse error'}`)
    }
  }
  const formatted = JSON.stringify(parsed, null, 2)
  return { type: 'json', data: parsed, lineCount: formatted.split('\n').length }
}
