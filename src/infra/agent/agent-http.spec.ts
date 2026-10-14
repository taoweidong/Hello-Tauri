import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createHttpAgent, probeAgent, type AgentHttpTransport } from './agent-http'

/**
 * agent-http 的**独立回归出口**（第二轮补缺口，N1）。
 *
 * 与 `ports.spec.ts` 的分工：那边钉的是「OpenAI 兼容协议长什么样」（请求体/鉴权头/
 * 响应解析/状态分类/并发留痕），这个文件钉的是那边**够不到的残余分支** —— 都是
 * 「服务端或宿主通道做了点出格的事，客户端会不会崩」这一类：
 *
 * | 位置 | 分支 | 为什么必须测 |
 * | --- | --- | --- |
 * | `:246-249` | onCall 钩子抛错 | 语料留痕是 R4 的合规要求；它若反噬业务主流程，等于「为了留痕把回复弄没了」 |
 * | `:229` | 抛出的不是 Error（字符串/null） | 宿主通道的 reject 形状不受控，直接读 `error.message` 会拿到 undefined 再炸一次 |
 * | `:81-106` | 地址守卫的极端输入 | 配置可被篡改指向公网 IP，守卫失效 = 对话原文外带 |
 *
 * 覆盖数字不是目的：这三条都是「出事时才会走到的路」，平时功能测试全绿。
 */

const httpOptions = (
  overrides: Partial<Parameters<typeof createHttpAgent>[0]> = {},
): Parameters<typeof createHttpAgent>[0] => ({
  baseUrl: 'http://127.0.0.1:11434',
  endpoint: '/v1/chat/completions',
  model: 'qwen3.8-flash',
  timeoutMs: 1000,
  ...overrides,
})

const OK_TRANSPORT: AgentHttpTransport = async () => ({
  status: 200,
  body: JSON.stringify({ choices: [{ message: { content: '答复正文' } }] }),
})

const noopTransport: AgentHttpTransport = () => new Promise(() => {})

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => ({ status: 200, text: async () => '{}' })))
})
afterEach(() => {
  vi.unstubAllGlobals()
})

describe('infra/agent —— agent-http 异常分支（钩子 / 非 Error / 地址守卫）', () => {
  it('onCall 钩子抛错不影响成功返回（留痕不能反噬业务）', async () => {
    const agent = createHttpAgent(httpOptions({ transport: OK_TRANSPORT }))
    let called = 0
    agent.onCall(() => {
      called += 1
      throw new Error('留痕钩子炸了')
    })
    await expect(agent.complete('问题')).resolves.toBe('答复正文')
    expect(called).toBe(1)
  })

  it('onCall 钩子抛错不影响失败抛出（原错误类型不失真）', async () => {
    const boom: AgentHttpTransport = async () => ({ status: 500, body: 'internal' })
    const agent = createHttpAgent(httpOptions({ transport: boom }))
    let called = 0
    agent.onCall(() => {
      called += 1
      throw new Error('留痕钩子炸了')
    })
    await expect(agent.complete('问题')).rejects.toThrow(/HTTP 500/)
    expect(called).toBe(1)
  })

  it('多个钩子中前一个抛错，后一个仍被调用（留痕不因单点故障整体丢失）', async () => {
    const agent = createHttpAgent(httpOptions({ transport: OK_TRANSPORT }))
    const seen: string[] = []
    agent.onCall(() => {
      throw new Error('第一个钩子炸了')
    })
    agent.onCall((record) => {
      seen.push(record.status)
    })
    await agent.complete('问题')
    expect(seen).toEqual(['ok'])
  })

  it('宿主页道 reject 一个非 Error（字符串）→ 归 error 类且消息被 String() 化，不二次崩溃', async () => {
    const transport = (() => Promise.reject('通道故障：连接被重置')) as unknown as AgentHttpTransport
    const agent = createHttpAgent(httpOptions({ transport }))
    await expect(agent.complete('问题')).rejects.toMatchObject({
      kind: 'error',
      message: '通道故障：连接被重置',
    })
  })

  it('地址无法解析（baseUrl 不是合法 URL）→ 可行动错误，不发请求', async () => {
    const transport = vi.fn(OK_TRANSPORT)
    const agent = createHttpAgent(httpOptions({ baseUrl: 'ht tp://坏地址', transport }))
    await expect(agent.complete('问题')).rejects.toThrow(/地址无法解析/)
    expect(transport).not.toHaveBeenCalled()
  })

  it('公网 literal IPv6 拒绝；IPv6 唯一本地地址（fd00::/8）放行', async () => {
    const transport = vi.fn(OK_TRANSPORT)
    const publicIpv6 = createHttpAgent(httpOptions({ baseUrl: 'http://[2001:db8::1]:9000', transport }))
    await expect(publicIpv6.complete('问题')).rejects.toThrow(/公网 IP/)

    const ula = createHttpAgent(httpOptions({ baseUrl: 'http://[fd00::1]:9000', transport }))
    await expect(ula.complete('问题')).resolves.toBe('答复正文')
    expect(transport).toHaveBeenCalledTimes(1)
  })

  it('非 2xx 且响应体为空 → 错误消息不拖一个空冒号（UI 直接展示）', async () => {
    const empty: AgentHttpTransport = async () => ({ status: 502, body: '' })
    await expect(createHttpAgent(httpOptions({ transport: empty })).complete('问题')).rejects.toThrow(
      'Agent 返回 HTTP 502',
    )
  })

  it('端点拼接：baseUrl 末尾无斜杠且 endpoint 无斜杠时自动补一个', async () => {
    const transport = vi.fn(OK_TRANSPORT)
    await createHttpAgent(httpOptions({ baseUrl: 'http://127.0.0.1:11434', endpoint: 'v1/chat', transport })).complete(
      '问题',
    )
    expect(transport.mock.calls[0][0]).toBe('http://127.0.0.1:11434/v1/chat')
  })

  it('probeAgent 走同一条链路：成功给摘要，失败抛出（设置页按钮据此显示状态）', async () => {
    const ok = await probeAgent(httpOptions({ transport: OK_TRANSPORT }))
    expect(ok.preview).toBe('答复正文')
    await expect(probeAgent(httpOptions({ transport: noopTransport, timeoutMs: 5 }))).rejects.toThrow(/超时/)
  })
})
