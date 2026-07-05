import { describe, it, expect } from 'vitest'
import { PluginRegistry } from '@/plugins/registry'
import { registerBuiltinPlugins } from '@/plugins/manifest'

describe('registerBuiltinPlugins', () => {
  it('注册所有内置压缩插件（zip、gzip）', () => {
    const registry = new PluginRegistry()
    registerBuiltinPlugins(registry)

    expect(registry.getCompression('.zip')).not.toBeNull()
    expect(registry.getCompression('.gz')).not.toBeNull()
    expect(registry.getCompression('.gzip')).not.toBeNull()
    expect(registry.getCompression('.tgz')).not.toBeNull()
  })

  it('注册所有内置解析插件（text、csv、json、log、hex）', () => {
    const registry = new PluginRegistry()
    registerBuiltinPlugins(registry)

    expect(registry.getParser('.txt')).not.toBeNull()
    expect(registry.getParser('.csv')).not.toBeNull()
    expect(registry.getParser('.json')).not.toBeNull()
    expect(registry.getParser('.log')).not.toBeNull()
  })

  it('text 插件注册多个扩展名', () => {
    const registry = new PluginRegistry()
    registerBuiltinPlugins(registry)

    const textExts = ['.txt', '.md', '.cfg', '.ini', '.env', '.yaml', '.yml', '.toml']
    for (const ext of textExts) {
      expect(registry.getParser(ext)).not.toBeNull()
    }
  })

  it('注册后 registry 的 hasParser / hasCompression 返回正确值', () => {
    const registry = new PluginRegistry()
    registerBuiltinPlugins(registry)

    expect(registry.hasParser('text')).toBe(true)
    expect(registry.hasParser('csv')).toBe(true)
    expect(registry.hasParser('json')).toBe(true)
    expect(registry.hasParser('log')).toBe(true)
    expect(registry.hasParser('hex')).toBe(true)
    expect(registry.hasCompression('zip')).toBe(true)
    expect(registry.hasCompression('gzip')).toBe(true)
  })

  it('未注册的扩展名返回 null', () => {
    const registry = new PluginRegistry()
    registerBuiltinPlugins(registry)

    expect(registry.getParser('.png')).toBeNull()
    expect(registry.getCompression('.rar')).toBeNull()
  })
})
