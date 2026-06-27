import { describe, it, expect } from 'vitest'
import { hexPlugin } from '@/plugins/parser/hex-plugin'

describe('hexPlugin', () => {
  it('canParse always returns true (fallback parser)', () => {
    expect(hexPlugin.canParse({ name: 'file.bin', path: '/', size: 0, isDirectory: false })).toBe(true)
  })

  it('parse returns hex dump with correct lineCount', async () => {
    const data = new Uint8Array([0x48, 0x65, 0x6c, 0x6c, 0x6f])
    const result = await hexPlugin.parse(data)
    expect(result.type).toBe('hex')
    expect(result.data).toBe(data)
    expect(result.lineCount).toBe(1)
  })

  it('parse handles empty data', async () => {
    const data = new Uint8Array(0)
    const result = await hexPlugin.parse(data)
    expect(result.lineCount).toBe(0)
  })

  it('parse handles data larger than 16 bytes (multiple lines)', async () => {
    const data = new Uint8Array(32)
    const result = await hexPlugin.parse(data)
    expect(result.lineCount).toBe(2)
  })
})
