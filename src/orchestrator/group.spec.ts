import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 快速建群编排单测（migration v3）。
 *
 * 这一层的全部价值在于「先闸门 → 再留痕 → 后外呼」的**顺序与终态语义**：
 *  *闸门必须最先过**（S-02：建群是第二条外发路径，急停/静默/频率都要拦得住，
 *    且拦截时不留pending 留痕 —— 没有任何对外动作发生，不该污染历史）；
 *  * createJob 必须发生在 port.createGroup 之前（留痕是外呼的许可凭据）；
 *  * 外呼失败必须落 failed 且携带错误全文（不静默、不重试）；
 *  * 终态回写被人抢写时如实上报 finalized=false（UI 不谎报成功）。
 */

import {
  GroupGateError,
  runGroupCreation,
  validateGroupDraft,
  validateGroupMembers,
  type GroupCreationDeps,
} from '@/orchestrator/group'
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

/** 闸门替身：默认放行，可断言调用次数（配额只在成功后扣） */
function fakeGate(
  decision: { action: string; reason: string; detail: string; terminal?: boolean } = {
    action: 'send',
    reason: '',
    detail: '放行',
  },
) {
  return {
    checkGroupAction: vi.fn(() => decision),
    onGroupCreated: vi.fn(),
  }
}

const deps = () => ({ repo: fakeRepo(), port: fakePort(), gate: fakeGate() })

/** 测试替身只实现被用到的三个方法，在使用点收敛为端口类型（保留 mock 方法可供断言） */
function asDeps(d: {
  repo: ReturnType<typeof fakeRepo>
  port: ReturnType<typeof fakePort>
  gate: ReturnType<typeof fakeGate>
}): GroupCreationDeps {
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
    const { repo, port, gate } = deps()
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

    const { job, finalized } = await runGroupCreation(asDeps({ repo, port, gate }), draft)
    expect(order).toEqual(['createJob', 'createGroup', 'completeJob'])
    expect(port.createGroup).toHaveBeenCalledWith({ name: '项目周会群', memberIds: ['E-0001', 'E-0002'] })
    expect(job.status).toBe('success')
    expect(job.groupId).toBe('G-777')
    expect(job.finishedAt).toBeTruthy()
    expect(finalized).toBe(true)
  })

  it('失败路径：错误全文落 failed，外呼不重试（port 只被调用一次）', async () => {
    const { repo, port, gate } = deps()
    port.createGroup.mockRejectedValue(new Error('成员不存在：E-9999'))

    const { job, finalized } = await runGroupCreation(asDeps({ repo, port, gate }), draft)
    expect(port.createGroup).toHaveBeenCalledTimes(1)
    expect(repo.failJob).toHaveBeenCalledWith(7, '成员不存在：E-9999')
    expect(repo.completeJob).not.toHaveBeenCalled()
    expect(job.status).toBe('failed')
    expect(job.error).toBe('成员不存在：E-9999')
    expect(job.finishedAt).toBeTruthy()
    expect(finalized).toBe(true)
  })

  it('非 Error 的异常也能落痕（String 化，不留空错误）', async () => {
    const { repo, port, gate } = deps()
    port.createGroup.mockRejectedValue('进程崩溃')
    const { job } = await runGroupCreation(asDeps({ repo, port, gate }), draft)
    expect(job.error).toBe('进程崩溃')
  })

  it('成功回写被抢（completeJob 返回 false）→ finalized=false，如实上报不谎报', async () => {
    const { repo, port, gate } = deps()
    repo.completeJob.mockResolvedValue(false)
    const { job, finalized } = await runGroupCreation(asDeps({ repo, port, gate }), draft)
    expect(job.status).toBe('success')
    expect(finalized).toBe(false)
  })

  it('失败回写被抢（failJob 返回 false）→ finalized=false', async () => {
    const { repo, port, gate } = deps()
    port.createGroup.mockRejectedValue(new Error('boom'))
    repo.failJob.mockResolvedValue(false)
    const { finalized } = await runGroupCreation(asDeps({ repo, port, gate }), draft)
    expect(finalized).toBe(false)
  })

  it('留痕失败直接抛（写不进凭据就不该外呼 —— 铁律本身不降级）', async () => {
    const { repo, port, gate } = deps()
    repo.createJob.mockRejectedValue(new Error('db 锁死'))
    await expect(runGroupCreation(asDeps({ repo, port, gate }), draft)).rejects.toThrow('db 锁死')
    expect(port.createGroup).not.toHaveBeenCalled()
  })

  it('成功后才扣建群配额（外呼失败不白吃配额，与消息侧 onSent 同原则）', async () => {
    const { repo, port, gate } = deps()
    await runGroupCreation(asDeps({ repo, port, gate }), draft)
    expect(gate.onGroupCreated).toHaveBeenCalledTimes(1)

    // 失败路径不得扣
    vi.clearAllMocks()
    const failed = deps()
    failed.port.createGroup.mockRejectedValue(new Error('boom'))
    await runGroupCreation(asDeps(failed), draft)
    expect(failed.gate.onGroupCreated).not.toHaveBeenCalled()
  })

  it('闸门在留痕之前判定：拦截时不留pending 凭据、不外呼（没发生对外动作）', async () => {
    const { repo, port, gate } = deps()
    gate.checkGroupAction.mockReturnValue({
      action: 'skip',
      reason: 'panic',
      detail: '全局急停中，建群已被阻断',
    })

    await expect(runGroupCreation(asDeps({ repo, port, gate }), draft)).rejects.toBeInstanceOf(GroupGateError)

    // 关键断言：闸门拦下的连留痕都不该有—— 历史里不该出现「被拦住」的失败记录
    expect(repo.createJob).not.toHaveBeenCalled()
    expect(port.createGroup).not.toHaveBeenCalled()
    expect(gate.onGroupCreated).not.toHaveBeenCalled()
  })

  it('闸门放行时才留痕，且顺序是 闸门 → 留痕 → 外呼 → 回写', async () => {
    const { repo, port, gate } = deps()
    const order: string[] = []
    gate.checkGroupAction.mockImplementation(() => {
      order.push('checkGate')
      return { action: 'send', reason: '', detail: '放行' }
    })
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

    await runGroupCreation(asDeps({ repo, port, gate }), draft)

    expect(order).toEqual(['checkGate', 'createJob', 'createGroup', 'completeJob'])
  })

  it('闸门的 defer（静默时段/频率超限）同样拦下，且带可展示的原因', async () => {
    const { repo, port, gate } = deps()
    gate.checkGroupAction.mockReturnValue({
      action: 'defer',
      reason: 'quiet',
      detail: '静默时段（22:00–08:00），时段结束后可再建群',
      terminal: false,
    })

    const error = await runGroupCreation(asDeps({ repo, port, gate }), draft).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(GroupGateError)
    expect((error as GroupGateError).message).toContain('静默时段')
    // defer 是「可自动恢复」，UI 用warning 而非 error 提示
    expect((error as GroupGateError).decision.action).toBe('defer')
    expect((error as GroupGateError).decision.terminal).toBe(false)
    expect(port.createGroup).not.toHaveBeenCalled()
  })

  it('闸门拿到的是群名（错误信息要能定位是哪个群被拦）', async () => {
    const { repo, port, gate } = deps()
    gate.checkGroupAction.mockReturnValue({ action: 'skip', reason: 'panic', detail: '急停' })
    await runGroupCreation(asDeps({ repo, port, gate }), draft).catch(() => undefined)
    expect(gate.checkGroupAction).toHaveBeenCalledWith({ groupName: '项目周会群' })
  })
})

describe('orchestrator/group —— validateGroupMembers（成员规模与格式，S-02 配套）', () => {
  it('成员数超上限报出（防单个 argv 膨胀到几 MB 触发 E2BIG）', () => {
    const many = Array.from({ length: 501 }, (_, i) => `E-${i}`)
    expect(validateGroupMembers(many)).toContain('群成员不能超过 500 人（当前 501）')
  })

  it('500 人整通过（上限是闭区间，不误伤）', () => {
    const exact = Array.from({ length: 500 }, (_, i) => `E-${i}`)
    expect(validateGroupMembers(exact)).toEqual([])
  })

  it('空项/超长/含逗号/重复分别报出', () => {
    expect(validateGroupMembers(['E-1', '  '])).toContain('成员列表含空项')
    expect(validateGroupMembers(['x'.repeat(201)])).toContain('成员标识不能超过 200 字')
    expect(validateGroupMembers(['E-1,E-2'])).toContain('成员标识不能含英文逗号（它用于分隔多人）')
    expect(validateGroupMembers(['E-1', 'E-1'])).toContain('成员列表含重复项')
  })

  it('全角逗号不算分隔符（它会被归一化掉，不是这里要拦的）', () => {
    expect(validateGroupMembers(['E-1，E-2'])).toEqual([])
  })

  it('成员规模超限时：闸门已放行但仍不留痕、不外呼', async () => {
    const { repo, port, gate } = deps()
    const huge = { ...draft, members: Array.from({ length: 501 }, (_, i) => `E-${i}`) }
    const error = await runGroupCreation(asDeps({ repo, port, gate }), huge).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(GroupGateError)
    expect((error as GroupGateError).decision.reason).toBe('invalid_members')
    expect(repo.createJob).not.toHaveBeenCalled()
    expect(port.createGroup).not.toHaveBeenCalled()
  })
})
