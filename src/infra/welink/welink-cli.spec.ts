import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { WelinkConversation } from '@/types/welink'
import { WelinkError } from './port'
import { createCliWelinkPort } from './welink-cli'

/**
 * 真实 CLI 适配器的编排层测试（quality-hardening-2026-10 5.1）：
 * exec（传输）/ adapter（解析）以桩注入 —— 本文件只钉住 welink-cli.ts 自己的
 * 编排职责：参数组装、批上限钳制、游标兜底、发送不重试、回执缺失归类。
 * 解析与传输的完整行为各有自己的 spec（adapter 解析在 facade/ports.spec 链路，
 * exec 的重试/超时语义在 exec 覆盖里）。
 */

const { runForOutput, withTransportRetry, parseListOutput, parsePullOutput, parseSendOutput } = vi.hoisted(() => ({
  runForOutput: vi.fn(async (_program: string, _args: string[], _opts?: unknown): Promise<string> => 'RAW'),
  withTransportRetry: vi.fn(),
  parseListOutput: vi.fn((_raw: string): WelinkConversation[] => []),
  parsePullOutput: vi.fn(
    (_raw: string, _ctx: unknown): { messages: Array<{ sentAt: string }>; cursor: string } => ({ messages: [], cursor: '' }),
  ),
  parseSendOutput: vi.fn((_raw: string, _seed: string): string => ''),
}))

vi.mock('./exec', () => ({
  runForOutput: (program: string, args: string[], opts?: unknown) => runForOutput(program, args, opts),
  withTransportRetry: (task: () => Promise<unknown>) => withTransportRetry(task),
}))
vi.mock('./adapter', () => ({
  parseListOutput: (raw: string) => parseListOutput(raw),
  parsePullOutput: (raw: string, ctx: unknown) => parsePullOutput(raw, ctx),
  parseSendOutput: (raw: string, seed: string) => parseSendOutput(raw, seed),
}))

const conv = { convId: 'G-1', convType: 'group' } as WelinkConversation

describe('welink-cli 真实适配器（编排职责）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    runForOutput.mockImplementation(async (): Promise<string> => 'RAW')
    withTransportRetry.mockImplementation((task: () => Promise<unknown>) => task())
  })

  it('listConversations：list 子命令 + json 标记 + 超时预算透传', async () => {
    const port = createCliWelinkPort({ cliPath: 'C:\\tools\\welink-cli.exe', myUserId: '10086' })
    await port.listConversations()
    expect(runForOutput).toHaveBeenCalledWith(
      'C:\\tools\\welink-cli.exe',
      ['list', '--json'],
      { timeoutMs: 12_000 },
    )
    expect(parseListOutput).toHaveBeenCalledWith('RAW')
  })

  it('pull：批上限钳到 MAX_BATCH=200（配置改大也越不过 P8 载荷线）', async () => {
    const port = createCliWelinkPort({ cliPath: 'welink-cli', myUserId: 'u' })
    await port.pull(conv, 'cursor-9', 500)
    const args = runForOutput.mock.calls[0][1] as string[]
    expect(args).toContain('--limit')
    expect(args[args.indexOf('--limit') + 1]).toBe('200')
    expect(args).toContain('--after')
    expect(args[args.indexOf('--after') + 1]).toBe('cursor-9')
  })

  it('pull：after 为空串时省略 --after（首拉取最新一批，不从纪元开始）', async () => {
    const port = createCliWelinkPort({ cliPath: 'welink-cli', myUserId: 'u' })
    await port.pull(conv, '', 10)
    expect(runForOutput.mock.calls[0][1]).not.toContain('--after')
  })

  it('pull：CLI 无回传游标 → 用最后一条消息时间兜底 [CLI-ASSUME]', async () => {
    parsePullOutput.mockReturnValue({ messages: [{ sentAt: '2026-10-03 09:00:00' }], cursor: '' })
    const port = createCliWelinkPort({ cliPath: 'welink-cli', myUserId: 'u' })
    const result = await port.pull(conv, 'old', 10)
    expect(result.cursor).toBe('ts:2026-10-03 09:00:00')
  })

  it('pull：本批无消息 → 游标保持原值（宁可少拉不重复拉全量）', async () => {
    parsePullOutput.mockReturnValue({ messages: [], cursor: '' })
    const port = createCliWelinkPort({ cliPath: 'welink-cli', myUserId: 'u' })
    const result = await port.pull(conv, 'old', 10)
    expect(result.cursor).toBe('old')
  })

  it('pull：CLI 自带游标 → 原样透传', async () => {
    parsePullOutput.mockReturnValue({ messages: [{ sentAt: 'x' }], cursor: 'cursor-cli' })
    const port = createCliWelinkPort({ cliPath: 'welink-cli', myUserId: 'u' })
    const result = await port.pull(conv, 'old', 10)
    expect(result.cursor).toBe('cursor-cli')
  })

  it('pull 的解析上下文带工号与会话标识（@我 判定 / 自发过滤依赖）', async () => {
    const port = createCliWelinkPort({ cliPath: 'welink-cli', myUserId: '10086' })
    await port.pull(conv, '', 10)
    expect(parsePullOutput).toHaveBeenCalledWith('RAW', {
      myUserId: '10086',
      convId: 'G-1',
      convType: 'group',
    })
  })

  it('send：不做传输层重试 —— 传输故障直接抛出（防双发底线，§6.2）', async () => {
    runForOutput.mockRejectedValue(new WelinkError('进程起不来', 'transport'))
    const port = createCliWelinkPort({ cliPath: 'welink-cli', myUserId: 'u' })
    await expect(port.send(conv, '你好')).rejects.toBeInstanceOf(WelinkError)
    expect(runForOutput).toHaveBeenCalledTimes(1)
    expect(withTransportRetry).not.toHaveBeenCalled()
  })

  it('send：成功但无回执 ID → parse 错误（不假装发送成功）', async () => {
    parseSendOutput.mockReturnValue('')
    const port = createCliWelinkPort({ cliPath: 'welink-cli', myUserId: 'u' })
    const error = await port.send(conv, '你好').catch((e: unknown) => e)
    expect(error).toBeInstanceOf(WelinkError)
    expect((error as WelinkError).kind).toBe('parse')
  })

  it('send：取得回执 → 返回 msgUid', async () => {
    parseSendOutput.mockReturnValue('uid-42')
    const port = createCliWelinkPort({ cliPath: 'welink-cli', myUserId: 'u' })
    await expect(port.send(conv, '你好')).resolves.toEqual({ msgUid: 'uid-42' })
    expect(parseSendOutput).toHaveBeenCalledWith('RAW', expect.stringContaining('G-1'))
  })

  it('超时预算：显式传入时优先生效且不超 12s 上限语义由调用方钳制', async () => {
    const port = createCliWelinkPort({ cliPath: 'welink-cli', myUserId: 'u', timeoutMs: 5_000 })
    await port.listConversations()
    expect(runForOutput.mock.calls[0][2]).toEqual({ timeoutMs: 5_000 })
  })
})
