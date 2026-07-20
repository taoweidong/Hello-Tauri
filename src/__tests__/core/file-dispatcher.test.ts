import { describe, it, expect, vi, beforeEach } from 'vitest'
import { FileDispatcher, UnsupportedPlaceholder } from '@/core/file-dispatcher'
import type { PluginRegistry } from '@/plugins/registry'
import type { IFileParserPlugin } from '@/plugins/types'

/** 创建 mock 解析插件 */
function createMockPlugin(name: string, ext: string, parseResult: any = { type: 'text', data: 'test' }): IFileParserPlugin {
  return {
    name,
    supportedExtensions: [ext],
    canParse: (file: { name: string }) => file.name.endsWith(ext),
    parse: vi.fn().mockResolvedValue(parseResult),
    getComponent: () => ({ name: `${name}-renderer` }),
  }
}

/** 创建 mock 注册表 */
function createMockRegistry(plugins: Map<string, IFileParserPlugin> = new Map()): PluginRegistry {
  return {
    resolveFileType: vi.fn((fileName: string) => {
      for (const [name, plugin] of plugins) {
        if (plugin.canParse({ name: fileName, size: 0, path: fileName })) {
          return name
        }
      }
      return 'unsupported'
    }),
    getParserByName: vi.fn((name: string) => plugins.get(name) ?? null),
    safeParse: vi.fn(async (plugin: IFileParserPlugin, data: Uint8Array, options?: any) => {
      return plugin.parse(data, options)
    }),
  } as unknown as PluginRegistry
}

describe('FileDispatcher', () => {
  let textPlugin: IFileParserPlugin
  let csvPlugin: IFileParserPlugin
  let registry: PluginRegistry
  let dispatcher: FileDispatcher

  beforeEach(() => {
    textPlugin = createMockPlugin('text', '.txt', { type: 'text', data: 'hello' })
    csvPlugin = createMockPlugin('csv', '.csv', { type: 'csv', data: { headers: ['a'], rows: [['1']] } })
    const plugins = new Map<string, IFileParserPlugin>([
      ['text', textPlugin],
      ['csv', csvPlugin],
    ])
    registry = createMockRegistry(plugins)
    dispatcher = new FileDispatcher(registry)
  })

  describe('resolveType', () => {
    it('识别支持的文件类型', () => {
      const result = dispatcher.resolveType('test.txt')
      expect(result.type).toBe('text')
      expect(result.matchedBy).toBe('suffixRule')
    })

    it('无扩展名文件返回 prefixRule', () => {
      vi.mocked(registry.resolveFileType).mockReturnValue('text')
      const result = dispatcher.resolveType('Makefile')
      expect(result.matchedBy).toBe('prefixRule')
    })

    it('不支持的类型返回 unsupported', () => {
      const result = dispatcher.resolveType('test.xyz')
      expect(result.type).toBe('unsupported')
      expect(result.matchedBy).toBe('none')
    })
  })

  describe('getParserFor', () => {
    it('返回对应的解析插件', () => {
      const parser = dispatcher.getParserFor('test.txt')
      expect(parser).toBe(textPlugin)
    })

    it('不支持的类型返回 null', () => {
      const parser = dispatcher.getParserFor('test.xyz')
      expect(parser).toBeNull()
    })
  })

  describe('getRendererFor', () => {
    it('返回对应的渲染组件', () => {
      const renderer = dispatcher.getRendererFor('test.txt')
      expect(renderer).toEqual({ name: 'text-renderer' })
    })

    it('不支持的类型返回 UnsupportedPlaceholder', () => {
      const renderer = dispatcher.getRendererFor('test.xyz')
      expect(renderer).toBe(UnsupportedPlaceholder)
    })

    it('插件无组件时返回 UnsupportedPlaceholder', () => {
      vi.mocked(registry.resolveFileType).mockReturnValue('text')
      vi.mocked(registry.getParserByName).mockReturnValue(null)
      const renderer = dispatcher.getRendererFor('test.txt')
      expect(renderer).toBe(UnsupportedPlaceholder)
    })
  })

  describe('dispatch', () => {
    it('成功调度并返回解析结果', async () => {
      const data = new Uint8Array([104, 101, 108, 108, 111])
      const result = await dispatcher.dispatch('test.txt', data)

      expect(result.fileType.type).toBe('text')
      expect(result.content).not.toBeNull()
      expect(result.renderer).toEqual({ name: 'text-renderer' })
      expect(result.loadTimeMs).toBeGreaterThanOrEqual(0)
    })

    it('不支持的类型返回空内容', async () => {
      const data = new Uint8Array([1, 2, 3])
      const result = await dispatcher.dispatch('test.xyz', data)

      expect(result.fileType.type).toBe('unsupported')
      expect(result.content).toBeNull()
      expect(result.renderer).toBe(UnsupportedPlaceholder)
      expect(result.loadTimeMs).toBe(0)
    })

    it('插件不存在时返回空内容', async () => {
      vi.mocked(registry.resolveFileType).mockReturnValue('text')
      vi.mocked(registry.getParserByName).mockReturnValue(null)

      const result = await dispatcher.dispatch('test.txt', new Uint8Array([1]))
      expect(result.content).toBeNull()
      expect(result.renderer).toBe(UnsupportedPlaceholder)
    })

    it('解析失败时返回空内容', async () => {
      vi.mocked(registry.safeParse).mockResolvedValue(null)

      const result = await dispatcher.dispatch('test.txt', new Uint8Array([1]))
      expect(result.content).toBeNull()
    })
  })
})

describe('UnsupportedPlaceholder', () => {
  it('是一个有效的 Vue 组件', () => {
    expect(UnsupportedPlaceholder.name).toBe('UnsupportedPlaceholder')
    expect(UnsupportedPlaceholder.props).toBeDefined()
  })
})
