import type { ParsedResult } from '@/plugins/types'

export function parseText(data: Uint8Array): ParsedResult {
  const text = new TextDecoder('utf-8').decode(data)
  const lineCount = text.length === 0 ? 0 : text.split('\n').length
  return { type: 'text', data: text, lineCount }
}
