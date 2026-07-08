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

  it('detectCompression 根据文件扩展名匹配压缩插件', () => {
    const plugin = createMockCompression('zip', ['.zip'])
    registry.registerCompression(plugin)
    const file: FileEntry = { name: 'data.zip', path: '/data.zip', size: 100, isDirectory: false }
    expect(registry.detectCompression(file)).toBe(plugin)
  })

  it('detectCompression 无匹配时返回 null', () => {
    const file: FileEntry = { name: 'data.txt', path: '/data.txt', size: 100, isDirectory: false }
    expect(registry.detectCompression(file)).toBeNull()
  })

  it('detectCompression 已禁用插件不返回', () => {
    const plugin = createMockCompression('zip', ['.zip'])
    registry.registerCompression(plugin)
    registry.disable('zip')
    const file: FileEntry = { name: 'data.zip', path: '/data.zip', size: 100, isDirectory: false }
    expect(registry.detectCompression(file)).toBeNull()
  })

  it('isEnabled 判断插件启用/禁用状态', () => {
    const plugin = createMockParser('text', ['.txt'])
    registry.registerParser(plugin)
    expect(registry.isEnabled('text')).toBe(true)
    registry.disable('text')
    expect(registry.isEnabled('text')).toBe(false)
    registry.enable('text')
    expect(registry.isEnabled('text')).toBe(true)
  })

  it('hasParser 和 hasCompression 检查注册状态', () => {
    const parser = createMockParser('text', ['.txt'])
    const comp = createMockCompression('zip', ['.zip'])
    expect(registry.hasParser('text')).toBe(false)
    expect(registry.hasCompression('zip')).toBe(false)
    registry.registerParser(parser)
    registry.registerCompression(comp)
    expect(registry.hasParser('text')).toBe(true)
    expect(registry.hasCompression('zip')).toBe(true)
  })

  it('getParserNames 和 getCompressionNames 返回已注册名称列表', () => {
    registry.registerParser(createMockParser('text', ['.txt']))
    registry.registerParser(createMockParser('csv', ['.csv']))
    registry.registerCompression(createMockCompression('zip', ['.zip']))
    expect(registry.getParserNames()).toEqual(['text', 'csv'])
    expect(registry.getCompressionNames()).toEqual(['zip'])
  })

  it('detectByFileName 根据文件名检测解析插件', () => {
    const plugin = createMockParser('json', ['.json'])
    registry.registerParser(plugin)
    expect(registry.detectByFileName('data.json')).toBe(plugin)
    expect(registry.detectByFileName('unknown.xyz')).toBeNull()
  })

  it('safeParse 成功路径返回解析结果', async () => {
    const plugin = createMockParser('text', ['.txt'])
    plugin.parse = async () => ({ type: 'text', data: 'hello world' })
    registry.registerParser(plugin)
    const result = await registry.safeParse(plugin, new Uint8Array(0))
    expect(result.type).toBe('text')
    expect(result.data).toBe('hello world')
  })

  it('safeDecompress 成功路径返回解压结果', async () => {
    const plugin = createMockCompression('zip', ['.zip'])
    plugin.decompress = async () => ({
      success: true,
      files: [{ name: 'a.txt', path: 'a.txt', size: 10, isDirectory: false }],
    })
    registry.registerCompression(plugin)
    const result = await registry.safeDecompress(plugin, new Uint8Array(0), '/tmp')
    expect(result.success).toBe(true)
    expect(result.files).toHaveLength(1)
  })

  it('safeDecompress 非 Error 异常使用默认错误信息', async () => {
    const failingPlugin: ICompressionPlugin = {
      name: 'failing2',
      supportedExtensions: ['.gz'],
      canHandle: () => true,
      decompress: async () => { throw 'string error' },
    }
    registry.registerCompression(failingPlugin)
    const result = await registry.safeDecompress(failingPlugin, new Uint8Array(0), '/tmp')
    expect(result.success).toBe(false)
    expect(result.error).toBe('解压失败')
  })
})
