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
    writeFile: vi.fn(),
    listFiles: vi.fn(),
    getTempDir: vi.fn(),
    decompress: vi.fn(),
    mmapRead: vi.fn(),
    streamRead: vi.fn(),
  } as any
}

function createMockRegistry() {
  return {
    getParser: vi.fn(),
    getParserByName: vi.fn(),
    resolveFileType: vi.fn(),
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
    registry.resolveFileType.mockReturnValue('text')
    registry.getParserByName.mockReturnValue(plugin)
    registry.safeParse.mockResolvedValue(parseResult)

    const result = await engine.resolveFile(node, 'archive1')

    expect(adapter.readFile).toHaveBeenCalledWith('/a.txt')
    expect(registry.resolveFileType).toHaveBeenCalledWith('a.txt')
    expect(registry.getParserByName).toHaveBeenCalledWith('text')
    expect(registry.safeParse).toHaveBeenCalledWith(plugin, data, { encoding: 'utf-8' })
    expect(result).not.toBeNull()
    expect(result!.type).toBe('text')
    expect(result!.pluginName).toBe('text')
    expect(result!.loadTimeMs).toBeGreaterThanOrEqual(0)
  })

  it('无扩展名文件通过前缀规则识别（如 APPLOG）', async () => {
    const data = new Uint8Array([1, 2, 3])
    const node: FileTreeNode = { key: '/APPLOG1', label: 'APPLOG1', isLeaf: true, path: '/APPLOG1' }

    ;(adapter.readFile as any).mockResolvedValue(data)
    const logPlugin = createMockParser('log')
    registry.resolveFileType.mockReturnValue('log')
    registry.getParserByName.mockReturnValue(logPlugin)
    registry.safeParse.mockResolvedValue({ type: 'log', data: [] })

    const result = await engine.resolveFile(node, 'archive1')

    expect(registry.resolveFileType).toHaveBeenCalledWith('APPLOG1')
    expect(result).not.toBeNull()
    expect(result!.pluginName).toBe('log')
  })

  it('不支持的文件类型返回 null', async () => {
    const data = new Uint8Array([1])
    const node: FileTreeNode = { key: '/x', label: 'x.unknown', isLeaf: true, path: '/x' }

    ;(adapter.readFile as any).mockResolvedValue(data)
    registry.resolveFileType.mockReturnValue('unsupported')

    const result = await engine.resolveFile(node, 'archive1')
    expect(result).toBeNull()
  })

  it('adapter.readFile 抛出异常时返回 null', async () => {
    const node: FileTreeNode = { key: '/err', label: 'err.txt', isLeaf: true, path: '/err' }
    ;(adapter.readFile as any).mockRejectedValue(new Error('IO error'))
    registry.resolveFileType.mockReturnValue('text')
    registry.getParserByName.mockReturnValue(createMockParser('text'))

    const result = await engine.resolveFile(node, 'archive1')
    expect(result).toBeNull()
  })

  it('safeParse 返回 null 时 resolveFile 返回 null', async () => {
    const data = new Uint8Array([1])
    const node: FileTreeNode = { key: '/a', label: 'a.bin', isLeaf: true, path: '/a' }

    ;(adapter.readFile as any).mockResolvedValue(data)
    const plugin = createMockParser('hex')
    registry.resolveFileType.mockReturnValue('hex')
    registry.getParserByName.mockReturnValue(plugin)
    registry.safeParse.mockResolvedValue(null)

    const result = await engine.resolveFile(node, 'archive1')
    expect(result).toBeNull()
  })

  it('支持自定义 encoding 参数', async () => {
    const data = new Uint8Array([1])
    const node: FileTreeNode = { key: '/a', label: 'a.log', isLeaf: true, path: '/a' }
    const plugin = createMockParser('log')

    ;(adapter.readFile as any).mockResolvedValue(data)
    registry.resolveFileType.mockReturnValue('log')
    registry.getParserByName.mockReturnValue(plugin)
    registry.safeParse.mockResolvedValue({ type: 'log', data: [] })

    await engine.resolveFile(node, 'archive1', 'gbk')
    expect(registry.safeParse).toHaveBeenCalledWith(plugin, data, { encoding: 'gbk' })
  })
})
