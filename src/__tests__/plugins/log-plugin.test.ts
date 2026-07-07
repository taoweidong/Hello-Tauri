import { describe, it, expect } from 'vitest'
import { logPlugin } from '@/plugins/parser/log-plugin'

describe('logPlugin', () => {
  it('canParse 对 .log 文件返回 true', () => {
    expect(logPlugin.canParse({ name: 'app.log', path: '/', size: 0, isDirectory: false })).toBe(true)
  })

  it('canParse 对非 .log 文件返回 false', () => {
    expect(logPlugin.canParse({ name: 'app.txt', path: '/', size: 0, isDirectory: false })).toBe(false)
    expect(logPlugin.canParse({ name: 'app.csv', path: '/', size: 0, isDirectory: false })).toBe(false)
  })

  it('parse 解析日志数据', async () => {
    const logText = '2024-01-01 12:00:00 [INFO] [main] 应用启动\n2024-01-01 12:00:01 [ERROR] [db] 连接失败'
    const data = new TextEncoder().encode(logText)
    const result = await logPlugin.parse(data)
    expect(result.type).toBe('log')
    expect(result.data).toBeDefined()
    expect(Array.isArray(result.data)).toBe(true)
  })

  it('parse 支持自定义编码选项', async () => {
    const logText = '2024-01-01 12:00:00 [WARN] [app] 警告信息'
    const data = new TextEncoder().encode(logText)
    const result = await logPlugin.parse(data, { encoding: 'utf-8' })
    expect(result.type).toBe('log')
  })

  it('getComponent 返回 LogRenderer 组件', () => {
    const component = logPlugin.getComponent()
    expect(component).toBeDefined()
  })

  it('插件名称为 log', () => {
    expect(logPlugin.name).toBe('log')
  })

  it('支持的扩展名包含 .log', () => {
    expect(logPlugin.supportedExtensions).toContain('.log')
  })
})
