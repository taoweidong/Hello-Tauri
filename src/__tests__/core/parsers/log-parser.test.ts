import { describe, it, expect } from 'vitest'
import { parseLog } from '@/core/parsers/log-parser'

describe('parseLog', () => {
  it('解析正常日志行', () => {
    const data = new TextEncoder().encode('2026-06-30 12:00:00 [INFO] [main] 应用启动')
    const result = parseLog(data)
    expect(result.type).toBe('log')
    expect(result.data).toHaveLength(1)
    expect(result.data[0]).toEqual({
      lineNumber: 1,
      timestamp: '2026-06-30 12:00:00',
      level: 'INFO',
      module: 'main',
      message: '应用启动',
      raw: '2026-06-30 12:00:00 [INFO] [main] 应用启动',
    })
    expect(result.lineCount).toBe(1)
  })

  it('不匹配行归 OTHER 并保留 raw', () => {
    const data = new TextEncoder().encode('这不是日志格式')
    const result = parseLog(data)
    expect(result.data[0].level).toBe('OTHER')
    expect(result.data[0].timestamp).toBe('')
    expect(result.data[0].module).toBe('')
    expect(result.data[0].raw).toBe('这不是日志格式')
  })

  it('空文件返回空数组', () => {
    const result = parseLog(new Uint8Array(0))
    expect(result.data).toEqual([])
    expect(result.lineCount).toBe(0)
  })

  it('混合行（正常 + 异常）', () => {
    const text = '2026-06-30 12:00:00 [ERROR] [api] 404\n乱码行\n2026-06-30 12:00:01 [WARN] [auth] 失败'
    const result = parseLog(new TextEncoder().encode(text))
    expect(result.data).toHaveLength(3)
    expect(result.data[0].level).toBe('ERROR')
    expect(result.data[1].level).toBe('OTHER')
    expect(result.data[2].level).toBe('WARN')
    expect(result.data[1].lineNumber).toBe(2)
  })

  it('未知级别归 OTHER', () => {
    const data = new TextEncoder().encode('2026-06-30 12:00:00 [TRACE] [x] y')
    const result = parseLog(data)
    expect(result.data[0].level).toBe('OTHER')
  })

  it('模块名含连字符', () => {
    const data = new TextEncoder().encode('2026-06-30 12:00:00 [INFO] [user-service] ok')
    const result = parseLog(data)
    expect(result.data[0].module).toBe('user-service')
  })
})
