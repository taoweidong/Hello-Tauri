import { describe, it, expect, beforeEach } from 'vitest'
import { PluginRegistry } from '@/plugins/registry'
import type { IFileParserPlugin, ICompressionPlugin } from '@/plugins/types'
import type { FileEntry } from '@/types'
import { defineComponent } from 'vue'

const DummyComponent = defineComponent({ template: '<div>dummy</div>' })

function createMockParser(name: string, exts: string[]): IFileParserPlugin {
  return {
    name,
    supportedExtensions: exts,
    canParse: (file: FileEntry) => exts.some(e => file.name.endsWith(e)),
    parse: async () => ({ type: 'text', data: 'mock' }),
    getComponent: () => DummyComponent,
  }
}

function createMockCompression(name: string, exts: string[]): ICompressionPlugin {
  return {
    name,
    supportedExtensions: exts,
    canHandle: (file: FileEntry) => exts.some(e => file.name.endsWith(e)),
    decompress: async () => ({ success: true, files: [] }),
  }
}

describe('PluginRegistry', () => {
  let registry: PluginRegistry

  beforeEach(() => {
    registry = new PluginRegistry()
  })

  it('registers and retrieves parser plugin by extension', () => {
    const plugin = createMockParser('text', ['.txt', '.log'])
    registry.registerParser(plugin)
    expect(registry.getParser('.txt')).toBe(plugin)
    expect(registry.getParser('.log')).toBe(plugin)
    expect(registry.getParser('.xyz')).toBeNull()
  })

  it('registers and retrieves compression plugin by extension', () => {
    const plugin = createMockCompression('zip', ['.zip'])
    registry.registerCompression(plugin)
    expect(registry.getCompression('.zip')).toBe(plugin)
    expect(registry.getCompression('.rar')).toBeNull()
  })

  it('detects parser plugin for a file', () => {
    const plugin = createMockParser('csv', ['.csv'])
    registry.registerParser(plugin)
    const file: FileEntry = { name: 'data.csv', path: '/data.csv', size: 100, isDirectory: false }
    expect(registry.detect(file)).toBe(plugin)
  })

  it('returns null when no plugin matches', () => {
    const file: FileEntry = { name: 'file.bin', path: '/file.bin', size: 100, isDirectory: false }
    expect(registry.detect(file)).toBeNull()
  })

  it('enables and disables plugins', () => {
    const plugin = createMockParser('text', ['.txt'])
    registry.registerParser(plugin)
    registry.disable('text')
    expect(registry.getParser('.txt')).toBeNull()
    registry.enable('text')
    expect(registry.getParser('.txt')).toBe(plugin)
  })

  it('safeParse catches errors and returns fallback', async () => {
    const failingPlugin: IFileParserPlugin = {
      name: 'failing',
      supportedExtensions: ['.txt'],
      canParse: () => true,
      parse: async () => { throw new Error('parse failed') },
      getComponent: () => DummyComponent,
    }
    registry.registerParser(failingPlugin)
    const result = await registry.safeParse(failingPlugin, new Uint8Array(0))
    expect(result).not.toBeNull()
    expect(result.type).toBe('hex')
  })

  it('safeDecompress catches errors and returns failure', async () => {
    const failingPlugin: ICompressionPlugin = {
      name: 'failing',
      supportedExtensions: ['.zip'],
      canHandle: () => true,
      decompress: async () => { throw new Error('decompress failed') },
    }
    registry.registerCompression(failingPlugin)
    const result = await registry.safeDecompress(failingPlugin, new Uint8Array(0), '/tmp')
    expect(result.success).toBe(false)
    expect(result.error).toBe('decompress failed')
  })
})
