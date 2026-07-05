import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ParserEngine } from '@/core/parser-engine'
import type { IPlatformAdapter } from '@/adapters/types'
import type { FileTreeNode } from '@/types'
import type { IFileParserPlugin } from '@/plugins/types'
import { defineComponent } from 'vue'

const DummyComponent = defineComponent({ template: '<div>dummy</div>' })

function createMockAdapter(): IPlatformAdapter {
  return {
    readFile: vi.fn(),
    readRange: vi.fn(),
    getFileSize: vi.fn(),
    decompress: vi.fn(),
    listFiles: vi.fn(),
    searchFiles: vi.fn(),
    getMimeType: vi.fn(),
  }
}

function createMockRegistry() {
  return {
    getParser: vi.fn(),
    safeParse: vi.fn(),
    detectCompression: vi.fn(),
    safeDecompress: vi.fn(),
    detect: vi.fn(),
    registerParser: vi.fn(),
    registerCompression: vi.fn(),
    enable: vi.fn(),
    disable: vi.fn(),
  } as any
}

function createMockParser(name: string): IFileParserPlugin {
  return {
    name,
    supportedExtensions: [],
    canParse: () => true,
    parse: vi.fn(),
    getComponent: () => DummyComponent,
  }
}

describe('ParserEngine', () => {
  let adapter: IPlatformAdapter
  let registry: ReturnType<typeof createMockRegistry>
  let engine: ParserEngine

  beforeEach(() => {
    adapter = createMockAdapter()
    registry = createMockRegistry()
    engine = new ParserEngine(adapter, registry)
  })

  it('正常解析文件并附加 loadTimeMs 和 pluginName', async () => {
    const data = new Uint8Array([72, 101, 108, 108, 111])
    const node: FileTreeNode = { key: '/a.txt', label: 'a.txt', isLeaf: true, path: '/a.txt' }
    const parseResult = { type: 'text' as const, data: 'Hello', lineCount: 1 }

    ;(adapter.readFile as any).mockResolvedValue(data)
    const plugin = createMockParser('text')
    registry.getParser.mockReturnValue(plugin)
    registry.safeParse.mockResolvedValue(parseResult)

    const result = await engine.resolveFile(node, 'archive1')

    expect(adapter.readFile).toHaveBeenCalledWith('/a.txt')
    expect(registry.getParser).toHaveBeenCalledWith('.txt')
    expect(registry.safeParse).toHaveBeenCalledWith(plugin, data, { encoding: 'utf-8' })
    expect(result).not.toBeNull()
    expect(result!.type).toBe('text')
    expect(result!.pluginName).toBe('text')
    expect(result!.loadTimeMs).toBeGreaterThanOrEqual(0)
  })

  it('无扩展名时回退到空字符串查找 hex 插件', async () => {
    const data = new Uint8Array([1, 2, 3])
    const node: FileTreeNode = { key: '/noext', label: 'noext', isLeaf: true, path: '/noext' }

    ;(adapter.readFile as any).mockResolvedValue(data)
    const hexPlugin = createMockParser('hex')
    // 第一次调用 getParser('') 返回 hex 插件
    registry.getParser.mockImplementation((ext: string) => {
      if (ext === '') return hexPlugin
      return null
    })
    registry.safeParse.mockResolvedValue({ type: 'hex', data })

    const result = await engine.resolveFile(node, 'archive1')

    expect(registry.getParser).toHaveBeenCalledWith('')
    expect(result).not.toBeNull()
    expect(result!.pluginName).toBe('hex')
  })

  it('无任何插件匹配时返回 null', async () => {
    const data = new Uint8Array([1])
    const node: FileTreeNode = { key: '/x', label: 'x', isLeaf: true, path: '/x' }

    ;(adapter.readFile as any).mockResolvedValue(data)
    registry.getParser.mockReturnValue(null)

    const result = await engine.resolveFile(node, 'archive1')
    expect(result).toBeNull()
  })

  it('adapter.readFile 抛出异常时返回 null', async () => {
    const node: FileTreeNode = { key: '/err', label: 'err.txt', isLeaf: true, path: '/err' }
    ;(adapter.readFile as any).mockRejectedValue(new Error('IO error'))

    const result = await engine.resolveFile(node, 'archive1')
    expect(result).toBeNull()
  })

  it('safeParse 返回 null 时 resolveFile 返回 null', async () => {
    const data = new Uint8Array([1])
    const node: FileTreeNode = { key: '/a', label: 'a.bin', isLeaf: true, path: '/a' }

    ;(adapter.readFile as any).mockResolvedValue(data)
    const plugin = createMockParser('hex')
    registry.getParser.mockReturnValue(plugin)
    registry.safeParse.mockResolvedValue(null)

    const result = await engine.resolveFile(node, 'archive1')
    expect(result).toBeNull()
  })

  it('支持自定义 encoding 参数', async () => {
    const data = new Uint8Array([1])
    const node: FileTreeNode = { key: '/a', label: 'a.log', isLeaf: true, path: '/a' }
    const plugin = createMockParser('log')

    ;(adapter.readFile as any).mockResolvedValue(data)
    registry.getParser.mockReturnValue(plugin)
    registry.safeParse.mockResolvedValue({ type: 'log', data: [] })

    await engine.resolveFile(node, 'archive1', 'gbk')
    expect(registry.safeParse).toHaveBeenCalledWith(plugin, data, { encoding: 'gbk' })
  })
})
