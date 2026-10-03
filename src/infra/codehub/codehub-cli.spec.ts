import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { CliResult } from '@/types'
import { CODEHUB_MAX_BATCH, type CodeHubMrRecord } from '@/types/codehub'
import { bytesToBase64, gbkBytes, utf8Bytes } from '@/utils/b64'
import { CodeHubError, type CodeHubListOptions } from './port'

/**
 * 真实 codehub-cli 适配器测试（注入假 cliRun，不依赖真实 CLI）。
 *
 * 钉住的是适配器的**分类与降级语义**（change design D1/D3/D5）：
 *  * 参数拼装：token 全局参数在前、state/limit 正确传递、limit 钳到 CODEHUB_MAX_BATCH；
 *  * 错误分类：超时/通道故障 → transport（可重试），CLI 非零退出 → parse，
 *    认证特征 → auth（引导改配置）；
 *  * 编码：UTF-8 严格解码失败退 GBK（中文 Windows 环境）；
 *  * 截断降级：完整元素照常解析入库、残缺元素丢弃；非截断的非法输出直接 parse；
 *  * 脱敏：任何错误信息不得出现 token 明文。
 */

const cliRun = vi.hoisted(() => vi.fn())

vi.mock('@/api', () => ({
  bridge: { cliRun },
  platform: 'tauri',
}))

const { createCliCodeHubPort, parseMrArray } = await import('./codehub-cli')

const PROGRAM = 'C:\\tools\\codehub-cli.exe'
const TOKEN = 'secret-token-value'

function cliResult(options: Partial<CliResult> & { stdoutText?: string; stderrText?: string }): CliResult {
  const { stdoutText = '', stderrText = '', ...rest } = options
  return {
    exitCode: 0,
    stdout: bytesToBase64(utf8Bytes(stdoutText)),
    stderr: bytesToBase64(utf8Bytes(stderrText)),
    stdoutTruncated: false,
    stderrTruncated: false,
    timedOut: false,
    durationMs: 5,
    ...rest,
  }
}

/** [CLI-ASSUME] 字段形状的夹具：与适配器的归一化假设一一对应 */
const LIST_JSON = JSON.stringify([
  {
    iid: '101',
    title: '网关限流',
    state: 'opened',
    author: 'alice',
    source_branch: 'feat/x',
    target_branch: 'main',
    updated_at: '2026-10-02T10:00:00+08:00',
    web_url: 'https://codehub.demo.local/mr/101',
    reviewers: ['bob', { username: 'carol' }],
    approvals: 1,
    unresolved_comments: 2,
    description: '描述',
    comments: [{ author: 'bob', body: '意见', created_at: '2026-10-02T10:30:00+08:00' }],
  },
  { iid: '99', title: '已合并', state: 'merged', comments: [] },
])

function port() {
  return createCliCodeHubPort({ cliPath: PROGRAM, token: TOKEN })
}

/** 端口返回 `{ records, degraded }`：多数用例只关心记录，降级语义由专门用例钉 */
async function list(repoId = 'demo/x', options: CodeHubListOptions = {}): Promise<CodeHubMrRecord[]> {
  const result = await port().listMergeRequests(repoId, options)
  return result.records
}

describe('codehub-cli 适配器 —— 参数拼装', () => {
  beforeEach(() => {
    cliRun.mockReset()
    cliRun.mockResolvedValue(cliResult({ stdoutText: '[]' }))
  })

  it('list：token 全局参数在最前，repo/format/limit 齐全，未筛状态时不带 --state', async () => {
    await port().listMergeRequests('demo/x')
    expect(cliRun).toHaveBeenCalledWith(
      PROGRAM,
      ['--token', TOKEN, 'mr', 'list', '--repo', 'demo/x', '--format', 'json', '--limit', String(CODEHUB_MAX_BATCH)],
      12_000,
    )
  })

  it('list：带状态筛选时追加 --state；limit 超上限时钳到 CODEHUB_MAX_BATCH', async () => {
    await port().listMergeRequests('demo/x', { state: 'open', limit: 5000 })
    const args = cliRun.mock.calls[0][1] as string[]
    expect(args).toContain('--state')
    expect(args[args.indexOf('--state') + 1]).toBe('open')
    expect(args[args.indexOf('--limit') + 1]).toBe(String(CODEHUB_MAX_BATCH))
  })

  it('view：单条详情参数正确', async () => {
    cliRun.mockResolvedValue(
      cliResult({ stdoutText: JSON.stringify({ iid: '101', title: 'T', state: 'open', comments: [] }) }),
    )
    await port().getMergeRequestDetail('demo/x', '101')
    expect(cliRun).toHaveBeenCalledWith(
      PROGRAM,
      ['--token', TOKEN, 'mr', 'view', '101', '--repo', 'demo/x', '--format', 'json'],
      12_000,
    )
  })
})

describe('codehub-cli 适配器 —— 解析与归一化', () => {
  beforeEach(() => {
    cliRun.mockReset()
  })

  it('正常数组输出归一化：字段映射、状态别名、reviewers 混合形态、详情可得', async () => {
    cliRun.mockResolvedValue(cliResult({ stdoutText: LIST_JSON }))
    const records = await list()
    expect(records).toHaveLength(2)
    const first = records[0]!.summary
    expect(first).toMatchObject({ repoId: 'demo/x', mrIid: '101', state: 'open', author: 'alice' })
    expect(first.review).toMatchObject({ reviewers: ['bob', 'carol'], approvals: 1, unresolved: 2 })
    expect(records[0]!.detail).toMatchObject({ description: '描述', comments: [{ author: 'bob', body: '意见' }] })
    // comments: [] 是合法详情（确实没有评论），不是「详情缺失」
    expect(records[1]!.detail).toEqual({ description: '', comments: [] })
  })

  it('GBK 输出兜底解码（中文 Windows 环境不丢字）', async () => {
    cliRun.mockResolvedValue(
      cliResult({ stdout: bytesToBase64(gbkBytes('[{"iid":"7","title":"中文测试","state":"open","comments":[]}]')) }),
    )
    const records = await list()
    expect(records[0]!.summary.title).toBe('中文测试')
  })

  it('comments 字段缺失 → detail 为 null（同步侧弃写详情列），列表字段仍在', async () => {
    cliRun.mockResolvedValue(
      cliResult({ stdoutText: JSON.stringify([{ iid: '5', title: '无详情', state: 'closed' }]) }),
    )
    const records = await list()
    expect(records[0]!.summary.mrIid).toBe('5')
    expect(records[0]!.detail).toBeNull()
  })

  it('iid/title 缺失或状态未知 → parse 故障（契约破坏不静默）', async () => {
    cliRun.mockResolvedValue(cliResult({ stdoutText: JSON.stringify([{ title: '缺 iid', state: 'open' }]) }))
    await expect(port().listMergeRequests('demo/x')).rejects.toMatchObject({ kind: 'parse' })
    cliRun.mockResolvedValue(
      cliResult({ stdoutText: JSON.stringify([{ iid: '1', title: '坏状态', state: 'weird', comments: [] }]) }),
    )
    await expect(port().listMergeRequests('demo/x')).rejects.toMatchObject({ kind: 'parse' })
  })

  it('view：对象输出归一化；详情字段缺失 → parse', async () => {
    cliRun.mockResolvedValue(
      cliResult({ stdoutText: JSON.stringify({ iid: '101', title: 'T', state: 'open', comments: [] }) }),
    )
    await expect(port().getMergeRequestDetail('demo/x', '101')).resolves.toMatchObject({ comments: [] })
    cliRun.mockResolvedValue(cliResult({ stdoutText: JSON.stringify({ iid: '101', title: 'T', state: 'open' }) }))
    await expect(port().getMergeRequestDetail('demo/x', '101')).rejects.toMatchObject({ kind: 'parse' })
  })
})

describe('codehub-cli 适配器 —— 错误分类', () => {
  beforeEach(() => {
    cliRun.mockReset()
  })

  it('超时 → transport；错误信息脱敏（无 token 明文）', async () => {
    cliRun.mockResolvedValue(cliResult({ timedOut: true, exitCode: null }))
    const error = await port()
      .listMergeRequests('demo/x')
      .catch((e: unknown) => e)
    expect(error).toBeInstanceOf(CodeHubError)
    expect((error as CodeHubError).kind).toBe('transport')
    expect((error as Error).message).toContain('[token 已省略')
    expect((error as Error).message).not.toContain(TOKEN)
  })

  it('通道故障（白名单拒绝/进程起不来）→ transport，且同轮只重试 1 次', async () => {
    cliRun.mockRejectedValueOnce(new Error('程序不在白名单')).mockResolvedValueOnce(cliResult({ stdoutText: '[]' }))
    await expect(list()).resolves.toEqual([])
    expect(cliRun).toHaveBeenCalledTimes(2)
    // 两次都失败则把最后一次抛给上层（交编排层退避）
    cliRun.mockRejectedValue(new Error('进程起不来'))
    await expect(port().listMergeRequests('demo/x')).rejects.toMatchObject({ kind: 'transport' })
    expect(cliRun).toHaveBeenCalledTimes(4)
  })

  it('CLI 非零退出：认证特征 → auth；普通报错 → parse（均不重试）', async () => {
    cliRun.mockResolvedValue(cliResult({ exitCode: 1, stderrText: 'authentication failed: invalid token' }))
    await expect(port().listMergeRequests('demo/x')).rejects.toMatchObject({ kind: 'auth' })
    expect(cliRun).toHaveBeenCalledTimes(1)
    cliRun.mockResolvedValue(cliResult({ exitCode: 2, stderrText: 'unknown subcommand' }))
    await expect(port().listMergeRequests('demo/x')).rejects.toMatchObject({ kind: 'parse' })
    expect(cliRun).toHaveBeenCalledTimes(2)
  })

  it('非截断的非法 JSON → parse；截断输出 → 抢救完整元素、丢弃残缺元素', async () => {
    cliRun.mockResolvedValue(cliResult({ stdoutText: '{"broken": ' }))
    await expect(port().listMergeRequests('demo/x')).rejects.toMatchObject({ kind: 'parse' })

    const truncated = '[{"iid":"1","title":"完整","state":"open","comments":[]},{"iid":"2","title":"残缺","state":"mer'
    const salvaged = parseMrArray(truncated, true)
    expect(salvaged.salvaged).toBe(true)
    expect(salvaged.items).toHaveLength(1)
    expect((salvaged.items[0] as Record<string, unknown>)['iid']).toBe('1')

    // 截断但整体恰好仍合法（截断发生在 stderr）→ 正常解析
    const whole = '[{"iid":"3","title":"合法","state":"merged","comments":[]}]'
    expect(parseMrArray(whole, true)).toEqual({ items: JSON.parse(whole), salvaged: false })
  })

  it('降级信号上抛：截断轮次 degraded=true 且记录照常返回（不静默少几条）', async () => {
    const truncated = '[{"iid":"1","title":"完整","state":"open","comments":[]},{"iid":"2","title":"残'
    cliRun.mockResolvedValue(cliResult({ stdoutText: truncated, stdoutTruncated: true }))
    const result = await port().listMergeRequests('demo/x')
    expect(result.degraded).toBe(true)
    expect(result.records).toHaveLength(1)
    expect(result.records[0]!.summary.mrIid).toBe('1')

    cliRun.mockResolvedValue(cliResult({ stdoutText: LIST_JSON }))
    await expect(port().listMergeRequests('demo/x')).resolves.toMatchObject({ degraded: false })
  })
})

describe('codehub-cli 适配器 —— 连通验证', () => {
  beforeEach(() => {
    cliRun.mockReset()
  })

  it('可用与不可用都走结果对象（永不 reject），原因带回配置页', async () => {
    cliRun.mockResolvedValue(cliResult({ stdoutText: 'ok' }))
    await expect(port().verifyConnection()).resolves.toMatchObject({ ok: true })
    cliRun.mockRejectedValue(new Error('进程起不来'))
    const result = await port().verifyConnection()
    expect(result.ok).toBe(false)
    expect(result.detail).toContain('进程起不来')
  })

  it('未配置 token 时不注入 --token 参数', async () => {
    const { createCliCodeHubPort: noTokenPort } = await import('./codehub-cli')
    cliRun.mockResolvedValue(cliResult({ stdoutText: 'ok' }))
    await noTokenPort({ cliPath: PROGRAM, token: '' }).verifyConnection()
    expect(cliRun.mock.calls[0]![1] as string[]).not.toContain('--token')
  })
})
