import { describe, it, expect } from 'vitest'
import { usePluginEngine } from '@/composables/use-plugins'

describe('usePluginEngine', () => {
  it('返回包含 registry 和操作方法的对象', () => {
    const engine = usePluginEngine()
    expect(engine.registry).toBeDefined()
    expect(typeof engine.detect).toBe('function')
    expect(typeof engine.getParser).toBe('function')
    expect(typeof engine.getCompression).toBe('function')
    expect(typeof engine.enable).toBe('function')
    expect(typeof engine.disable).toBe('function')
  })

  it('registry 为单例，多次调用返回同一实例', () => {
    const engine1 = usePluginEngine()
    const engine2 = usePluginEngine()
    expect(engine1.registry).toBe(engine2.registry)
  })

  it('内置解析插件已注册（text/csv/json/log/hex）', () => {
    const engine = usePluginEngine()
    expect(engine.getParser('.txt')).not.toBeNull()
    expect(engine.getParser('.csv')).not.toBeNull()
    expect(engine.getParser('.json')).not.toBeNull()
    expect(engine.getParser('.log')).not.toBeNull()
  })

  it('内置压缩插件已注册（zip/gzip）', () => {
    const engine = usePluginEngine()
    expect(engine.getCompression('.zip')).not.toBeNull()
    expect(engine.getCompression('.gz')).not.toBeNull()
  })

  it('detect 根据文件条目返回对应解析插件', () => {
    const engine = usePluginEngine()
    const file = { name: 'data.csv', path: '/data.csv', size: 100, isDirectory: false }
    const plugin = engine.detect(file)
    expect(plugin).not.toBeNull()
    expect(plugin!.name).toBe('csv')
  })

  it('detect 对无匹配扩展名的文件返回 null', () => {
    const engine = usePluginEngine()
    const file = { name: 'image.png', path: '/image.png', size: 100, isDirectory: false }
    // hex 插件 supportedExtensions 为空，detect 基于扩展名匹配，不会匹配 hex
    expect(engine.detect(file)).toBeNull()
  })

  it('enable/disable 控制插件可用性', () => {
    const engine = usePluginEngine()
    // 禁用 text 插件
    engine.disable('text')
    expect(engine.getParser('.txt')).toBeNull()

    // 重新启用
    engine.enable('text')
    expect(engine.getParser('.txt')).not.toBeNull()
  })
})
