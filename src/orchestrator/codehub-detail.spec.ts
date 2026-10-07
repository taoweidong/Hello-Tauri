import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { CodeHubPort } from '@/infra/codehub'
import { CodeHubError } from '@/infra/codehub/port'
import type { CodeHubRepository } from '@/infra/db'
import type { CodeHubMergeRequestDetail, CodeHubMrRecord } from '@/types/codehub'
import { createDetailBackfill } from './codehub-detail'

const logger = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }))
vi.mock('@/utils/logger', () => ({ logger }))

/**
 * 单条详情补拉单测（design D2 的 mr view 语义）。
 *
 * 这里钉的是编排层的调度不变量：快照命中绝不碰端口（浏览零子进程的那条例外只有
 * 「点开缺详情的条」）、补拉永不 reject、同一条在飞期间去重（连点不起 N 个子进程）、
 * 失败后允许重试。假端口 + 假仓储，不依赖真实 codehub-cli。
 */

const DETAIL: CodeHubMergeRequestDetail = {
  description: '正文',
  comments: [{ author: 'u', body: 'b', createdAt: 't' }],
}

function record(detail: CodeHubMergeRequestDetail | null): CodeHubMrRecord {
  return {
    summary: {
      repoId: 'demo/a',
      mrIid: '101',
      title: '标题',
      state: 'open',
      author: 'someone',
      sourceBranch: 'feat',
      targetBranch: 'main',
      updatedAt: '2026-10-02 10:00:00',
      webUrl: '',
      review: { reviewers: [], approvals: 0, unresolved: 0, lastActivityAt: '' },
    },
    detail,
  }
}

function fakeRepo(rows: Array<CodeHubMrRecord | null>) {
  let index = 0
  return {
    getMr: vi.fn(async () => rows[Math.min(index++, rows.length - 1)]),
    saveMrDetail: vi.fn(async () => true),
  } satisfies Pick<CodeHubRepository, 'getMr' | 'saveMrDetail'>
}

const port = { getMergeRequestDetail: vi.fn() } as unknown as CodeHubPort & {
  getMergeRequestDetail: ReturnType<typeof vi.fn>
}

describe('codehub 详情补拉', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    port.getMergeRequestDetail.mockResolvedValue(DETAIL)
  })

  it('快照已有详情：直接返回，不碰端口', async () => {
    const repo = fakeRepo([record(DETAIL)])
    const backfill = createDetailBackfill({ repo, port: () => port })
    await expect(backfill.fetch('demo/a', '101')).resolves.toEqual(record(DETAIL))
    expect(port.getMergeRequestDetail).not.toHaveBeenCalled()
    expect(repo.saveMrDetail).not.toHaveBeenCalled()
  })

  it('快照缺详情：补拉并把结果回填快照后返回', async () => {
    const repo = fakeRepo([record(null)])
    const backfill = createDetailBackfill({ repo, port: () => port, now: () => new Date('2026-10-03T08:00:00') })
    await expect(backfill.fetch('demo/a', '101')).resolves.toEqual(record(DETAIL))
    expect(port.getMergeRequestDetail).toHaveBeenCalledWith('demo/a', '101')
    expect(repo.saveMrDetail).toHaveBeenCalledWith('demo/a', '101', DETAIL, expect.stringMatching(/^\d{4}-\d{2}-\d{2}/))
  })

  it('未知 MR：返回 null 且不发起补拉', async () => {
    const repo = fakeRepo([null])
    const backfill = createDetailBackfill({ repo, port: () => port })
    await expect(backfill.fetch('demo/a', '999')).resolves.toBeNull()
    expect(port.getMergeRequestDetail).not.toHaveBeenCalled()
  })

  it('补拉失败永不 reject：返回缺详情的原记录并落一条告警', async () => {
    const repo = fakeRepo([record(null)])
    port.getMergeRequestDetail.mockRejectedValue(new CodeHubError('输出不是合法 JSON', 'parse'))
    const backfill = createDetailBackfill({ repo, port: () => port })
    await expect(backfill.fetch('demo/a', '101')).resolves.toEqual(record(null))
    expect(repo.saveMrDetail).not.toHaveBeenCalled()
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('详情补拉失败'))
  })

  it('同一条在飞期间去重：连点两次只起一次补拉', async () => {
    const repo = fakeRepo([record(null), record(null)])
    let release!: () => void
    port.getMergeRequestDetail.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve(DETAIL)
        }),
    )
    const backfill = createDetailBackfill({ repo, port: () => port })
    const first = backfill.fetch('demo/a', '101')
    expect(backfill.pending('demo/a', '101')).toBe(true)
    const second = backfill.fetch('demo/a', '101')
    // 让 run() 走到端口调用那一步（快照读 + 补拉之间隔着一个 await），再放行
    await new Promise((resolve) => setTimeout(resolve, 0))
    release()
    expect(await Promise.all([first, second])).toEqual([record(DETAIL), record(DETAIL)])
    expect(port.getMergeRequestDetail).toHaveBeenCalledTimes(1)
    expect(repo.getMr).toHaveBeenCalledTimes(1)
    expect(backfill.pending('demo/a', '101')).toBe(false)
  })

  it('失败后在飞表清理：再次点击会真再试一次', async () => {
    const repo = fakeRepo([record(null), record(null), record(null)])
    port.getMergeRequestDetail.mockRejectedValueOnce(new CodeHubError('通道故障', 'transport'))
    const backfill = createDetailBackfill({ repo, port: () => port })
    await expect(backfill.fetch('demo/a', '101')).resolves.toEqual(record(null))
    await expect(backfill.fetch('demo/a', '101')).resolves.toEqual(record(DETAIL))
    expect(port.getMergeRequestDetail).toHaveBeenCalledTimes(2)
  })

  it('reset 丢弃在飞表：复位后同一条重新发起补拉', async () => {
    const repo = fakeRepo([record(null), record(null)])
    const backfill = createDetailBackfill({ repo, port: () => port })
    const task = backfill.fetch('demo/a', '101')
    backfill.reset()
    expect(backfill.pending('demo/a', '101')).toBe(false)
    await task
    await backfill.fetch('demo/a', '101')
    expect(port.getMergeRequestDetail).toHaveBeenCalledTimes(2)
  })
})
