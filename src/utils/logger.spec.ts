import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { logger, onLog, registerSecret, resetSecretsForTest } from './logger'

/**
 * 统一日志出口（P10 旁路转发语义）：控制台 + 宿主 appendLog + 订阅者同步转发；
 * 「日志失败不阻断业务」的三处降级各有用例钉住。
 */

const { appendLog } = vi.hoisted(() => ({ appendLog: vi.fn(async (): Promise<string> => 'log-path') }))

vi.mock('@/api', () => ({
  bridge: { appendLog: (...args: unknown[]) => appendLog(...(args as [])) },
}))

describe('logger', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(console, 'info').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('onLog：订阅者同步收到日志（顺序即事件顺序）', () => {
    const sink = vi.fn()
    const unsubscribe = onLog(sink)
    logger.info('第一条')
    logger.warn('第二条')
    expect(sink).toHaveBeenNthCalledWith(1, 'info', '第一条')
    expect(sink).toHaveBeenNthCalledWith(2, 'warn', '第二条')
    unsubscribe()
  })

  it('退订后不再收到；退订函数可重复调用', () => {
    const sink = vi.fn()
    const unsubscribe = onLog(sink)
    unsubscribe()
    unsubscribe()
    logger.info('退订后')
    expect(sink).not.toHaveBeenCalled()
  })

  it('宿主 appendLog 被调用（level/message 原样）', () => {
    logger.info('落盘内容')
    expect(appendLog).toHaveBeenCalledWith('info', '落盘内容')
  })

  it('appendLog 失败：静默降级，不影响订阅者与控制台', async () => {
    appendLog.mockRejectedValueOnce(new Error('盘满'))
    const sink = vi.fn()
    const unsubscribe = onLog(sink)
    logger.warn('盘满也要看见')
    await vi.waitFor(() => expect(appendLog).toHaveBeenCalled())
    expect(sink).toHaveBeenCalledWith('warn', '盘满也要看见')
    unsubscribe()
  })

  it('订阅者抛异常：不打断其他订阅者（日志链路的鲁棒性）', () => {
    const bad = vi.fn(() => {
      throw new Error('订阅方炸了')
    })
    const good = vi.fn()
    const unsubscribeBad = onLog(bad)
    const unsubscribeGood = onLog(good)
    expect(() => logger.info('广播')).not.toThrow()
    expect(good).toHaveBeenCalledWith('info', '广播')
    unsubscribeBad()
    unsubscribeGood()
  })

  it('error：附异常时拼接 message + 堆栈', () => {
    const sink = vi.fn()
    const unsubscribe = onLog(sink)
    const boom = new Error('boom 详情')
    logger.error('启动失败', boom)
    const message = sink.mock.calls[0][1] as string
    expect(message).toContain('启动失败 :: boom 详情')
    expect(message).toContain('at ')
    unsubscribe()
  })

  it('error：非 Error 值转字符串；无附加值保持原样', () => {
    const sink = vi.fn()
    const unsubscribe = onLog(sink)
    logger.error('字符串异常', 'plain')
    logger.error('干净消息')
    expect(sink).toHaveBeenNthCalledWith(1, 'error', '字符串异常 :: plain')
    expect(sink).toHaveBeenNthCalledWith(2, 'error', '干净消息')
    unsubscribe()
  })
})

describe('logger —— 敏感值遮蔽（design D6：CodeHub token 全链路脱敏）', () => {
  beforeEach(() => {
    vi.spyOn(console, 'info').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    resetSecretsForTest()
  })

  afterEach(() => {
    resetSecretsForTest()
    vi.restoreAllMocks()
  })

  it('注册的敏感值在旁路订阅与落盘消息中都被等值替换', () => {
    registerSecret('super-secret-token-value')
    const sink = vi.fn()
    const unsubscribe = onLog(sink)
    logger.info('调用失败：--token super-secret-token-value 已被拒绝')
    expect(sink).toHaveBeenCalledWith('info', '调用失败：--token *** 已被拒绝')
    expect(appendLog).toHaveBeenCalledWith('info', '调用失败：--token *** 已被拒绝')
    unsubscribe()
  })

  it('error 级别拼接的异常详情同样遮蔽', () => {
    registerSecret('tok-abcdef1234')
    const sink = vi.fn()
    const unsubscribe = onLog(sink)
    logger.error('同步失败', new Error('bad args: --token tok-abcdef1234'))
    const message = sink.mock.calls[0][1] as string
    expect(message).not.toContain('tok-abcdef1234')
    expect(message).toContain('***')
    unsubscribe()
  })

  it('未注册值原样保留；过短值（<4 字符）不注册（误伤面大于收益）', () => {
    registerSecret('tok')
    const sink = vi.fn()
    const unsubscribe = onLog(sink)
    logger.info('token tok 原样出现')
    expect(sink).toHaveBeenCalledWith('info', 'token tok 原样出现')
    unsubscribe()
  })
})
