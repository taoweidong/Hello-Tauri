import { describe, expect, it } from 'vitest'

import { RagError } from './port'

/**
 * RagError 是检索降级链路的分类依据（pipeline 只把它当「可降级的失败」）。
 * 分类丢失或 cause 断开会让排障日志变成一句没有上下文的「检索失败」。
 */
describe('infra/rag/port（RagError）', () => {
  it('保留分类与 cause，且可被 instanceof Error 捕获', () => {
    const cause = new Error('ECONNREFUSED')
    const error = new RagError('检索服务不可用', 'transport', cause)
    expect(error).toBeInstanceOf(Error)
    expect(error).toBeInstanceOf(RagError)
    expect(error.name).toBe('RagError')
    expect(error.message).toBe('检索服务不可用')
    expect(error.kind).toBe('transport')
    expect(error.cause).toBe(cause)
  })

  it('parse 分类：响应形状不符时同样携带 cause', () => {
    const error = new RagError('响应缺少 chunks', 'parse', { got: 'html' })
    expect(error.kind).toBe('parse')
    expect(error.cause).toEqual({ got: 'html' })
  })
})
