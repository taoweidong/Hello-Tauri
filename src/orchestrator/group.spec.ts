import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 快速建群编排单测（migration v3）。
 *
 * 这一层的全部价值在于「先留痕后外呼」的**顺序与终态语义**：
 *  * createJob 必须发生在 port.createGroup 之前（留痕是外呼的许可凭据）；
 *  * 外呼失败必须落 failed 且携带错误全文（不静默、不重试）；
 *  * 终态回写被人抢写时如实上报 finalized=false（UI 不谎报成功）。
 */

import { runGroupCreation, validateGroupDraft, type GroupCreationDeps } from '@/orchestrator/group'
import type { GroupJob } from '@/types/welink'
import { normalizeMemberIds } from '@/types/welink'

function pendingJob(overrides: Partial<GroupJob> = {}): GroupJob {
  return {
    pk: 7,
    templatePk: null,
    templateName: '',
    groupName: '项目周会群',
    members: ['E-0001', 'E-0002'],
    status: 'pending',
    groupId: '',
    error: '',
    createdAt: '2026-09-30 10:00:00',
    finishedAt: null,
    ...overrides,
  }
}

function fakeRepo() {
  return {
    createJob: vi.fn(async (): Promise<GroupJob> => pendingJob()),
    completeJob: vi.fn(async (): Promise<boolean> => true),
    failJob: vi.fn(async (): Promise<boolean> => true),
  }
}

function fakePort() {
  return {
    createGroup: vi.fn(async (): Promise<{ groupId: string }> => ({ groupId: 'G-777' })),
  }
}

const deps = () => ({ repo: fakeRepo(), port: fakePort() })

/** 测试替身只实现被用到的三个方法，在使用点收敛为端口类型（保留 mock 方法可供断言） */
function asDeps(d: { repo: ReturnType<typeof fakeRepo>; port: ReturnType<typeof fakePort> }): GroupCreationDeps {
  return d as unknown as GroupCreationDeps
}

const draft = { templatePk: null, templateName: '', groupName: '项目周会群', members: ['E-0001', 'E-0002'] }

beforeEach(() => {
  vi.clearAllMocks()
})

describe('orchestrator/group —— validateGroupDraft', () => {
  it('空群名与空成员清单分别报出', () => {
    expect(validateGroupDraft({ groupName: '', members: [] })).toEqual(['请填写群名称', '请至少添加一名群成员'])
  })

  it('群名超长报出', () => {
    expect(validateGroupDraft({ groupName: 'x'.repeat(65), members: ['E-1'] })).toEqual(['群名称不能超过 64 字'])
  })

  it('合法输入无问题', () => {
    expect(validateGroupDraft({ groupName: '项目周会群', members: ['E-1'] })).toEqual([])
  })
})

describe('orchestrator/group —— normalizeMemberIds（输入归一化）', () => {
  it('中英文逗号/分号/空白/换行都是分隔符', () => {
    expect(normalizeMemberIds('E-1，E-2; E-3、E-4\nE-5\tE-6')).toEqual(['E-1', 'E-2', 'E-3', 'E-4', 'E-5', 'E-6'])
  })

  it('去空项与去重、保序', () => {
    expect(normalizeMemberIds('E-2, , E-1, E-2,  E-1')).toEqual(['E-2', 'E-1'])
  })
})

describe('orchestrator/group —— runGroupCreation（先留痕后外呼）', () => {
  it('成功路径：先落 pending，再外呼，再回写 success，顺序不可颠倒', async () => {
    const { repo, port } = deps()
    const order: string[] = []
    repo.createJob.mockImplementation(async () => {
      order.push('createJob')
      return pendingJob()
    })
    port.createGroup.mockImplementation(async () => {
      order.push('createGroup')
      return { groupId: 'G-777' }
    })
    repo.completeJob.mockImplementation(async () => {
      order.push('completeJob')
      return true
    })

    const { job, finalized } = await runGroupCreation(asDeps({ repo, port }), draft)
    expect(order).toEqual(['createJob', 'createGroup', 'completeJob'])
    expect(port.createGroup).toHaveBeenCalledWith({ name: '项目周会群', memberIds: ['E-0001', 'E-0002'] })
    expect(job.status).toBe('success')
    expect(job.groupId).toBe('G-777')
    expect(job.finishedAt).toBeTruthy()
    expect(finalized).toBe(true)
  })

  it('失败路径：错误全文落 failed，外呼不重试（port 只被调用一次）', async () => {
    const { repo, port } = deps()
    port.createGroup.mockRejectedValue(new Error('成员不存在：E-9999'))

    const { job, finalized } = await runGroupCreation(asDeps({ repo, port }), draft)
    expect(port.createGroup).toHaveBeenCalledTimes(1)
    expect(repo.failJob).toHaveBeenCalledWith(7, '成员不存在：E-9999')
    expect(repo.completeJob).not.toHaveBeenCalled()
    expect(job.status).toBe('failed')
    expect(job.error).toBe('成员不存在：E-9999')
    expect(job.finishedAt).toBeTruthy()
    expect(finalized).toBe(true)
  })

  it('非 Error 的异常也能落痕（String 化，不留空错误）', async () => {
    const { repo, port } = deps()
    port.createGroup.mockRejectedValue('进程崩溃')
    const { job } = await runGroupCreation(asDeps({ repo, port }), draft)
    expect(job.error).toBe('进程崩溃')
  })

  it('成功回写被抢（completeJob 返回 false）→ finalized=false，如实上报不谎报', async () => {
    const { repo, port } = deps()
    repo.completeJob.mockResolvedValue(false)
    const { job, finalized } = await runGroupCreation(asDeps({ repo, port }), draft)
    expect(job.status).toBe('success')
    expect(finalized).toBe(false)
  })

  it('失败回写被抢（failJob 返回 false）→ finalized=false', async () => {
    const { repo, port } = deps()
    port.createGroup.mockRejectedValue(new Error('boom'))
    repo.failJob.mockResolvedValue(false)
    const { finalized } = await runGroupCreation(asDeps({ repo, port }), draft)
    expect(finalized).toBe(false)
  })

  it('留痕失败直接抛（写不进凭据就不该外呼 —— 铁律本身不降级）', async () => {
    const { repo, port } = deps()
    repo.createJob.mockRejectedValue(new Error('db 锁死'))
    await expect(runGroupCreation(asDeps({ repo, port }), draft)).rejects.toThrow('db 锁死')
    expect(port.createGroup).not.toHaveBeenCalled()
  })
})
