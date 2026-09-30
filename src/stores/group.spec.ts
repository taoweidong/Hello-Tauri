import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

/**
 * 快速建群 store 单测（migration v3）。
 *
 * store 是薄转发层，这里只钉住它的**聚合职责**：
 *  * init 的启动清扫（pending → interrupted）有告警且幂等；
 *  * createGroup 把「校验 → 编排 → 历史版本号自增」串起来，失败也能推进版本号；
 *  * 模板 CRUD 的 create/update 分流与失败上抛。
 */

const { repoMock, portMock } = vi.hoisted(() => ({
  repoMock: {
    markInterrupted: vi.fn(async (): Promise<number> => 0),
    listTemplates: vi.fn(async (_limit?: number): Promise<unknown[]> => []),
    createTemplate: vi.fn(async (): Promise<unknown> => ({})),
    updateTemplate: vi.fn(async (): Promise<boolean> => true),
    removeTemplate: vi.fn(async (): Promise<boolean> => true),
    createJob: vi.fn(async (): Promise<unknown> => ({})),
    completeJob: vi.fn(async (): Promise<boolean> => true),
    failJob: vi.fn(async (): Promise<boolean> => true),
    listJobs: vi.fn(async (): Promise<unknown[]> => []),
    countJobs: vi.fn(async (): Promise<number> => 0),
    removeJob: vi.fn(async (): Promise<boolean> => true),
  },
  portMock: {
    createGroup: vi.fn(async (): Promise<{ groupId: string }> => ({ groupId: 'G-1' })),
  },
}))

vi.mock('@/infra/db', () => ({
  dbMigrateAll: vi.fn(async () => []),
  group: () => repoMock,
  TEMPLATE_HARD_LIMIT: 200,
}))
vi.mock('@/infra/welink', () => ({
  groupClient: vi.fn(() => portMock),
}))
vi.mock('@/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

import { useGroupStore } from '@/stores/group'
import { logger } from '@/utils/logger'

function jobOf(overrides: Record<string, unknown> = {}) {
  return {
    pk: 7,
    templatePk: null,
    templateName: '',
    groupName: '项目周会群',
    members: ['E-0001'],
    status: 'pending',
    groupId: '',
    error: '',
    createdAt: '2026-09-30 10:00:00',
    finishedAt: null,
    ...overrides,
  }
}

async function freshStore() {
  setActivePinia(createPinia())
  return useGroupStore()
}

const draft = { templatePk: null, templateName: '', groupName: '项目周会群', members: ['E-0001'] }

beforeEach(() => {
  vi.clearAllMocks()
})

describe('stores/group —— init', () => {
  it('启动清扫：遗留 pending 标记 interrupted 并告警', async () => {
    repoMock.markInterrupted.mockResolvedValue(2)
    const store = await freshStore()
    await store.init()
    expect(repoMock.markInterrupted).toHaveBeenCalledTimes(1)
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('2 条中断留痕'))
  })

  it('幂等：同一进程内重复 init 不重复清扫', async () => {
    const store = await freshStore()
    await store.init()
    await store.init()
    expect(repoMock.markInterrupted).toHaveBeenCalledTimes(1)
  })

  it('迁移失败时不再继续装载（表都不在，查询只会刷错误）', async () => {
    const { dbMigrateAll } = await import('@/infra/db')
    vi.mocked(dbMigrateAll).mockRejectedValueOnce(new Error('db 锁死'))
    const store = await freshStore()
    const ok = await store.init()
    expect(ok).toBe(false)
    expect(repoMock.listTemplates).not.toHaveBeenCalled()
    expect(logger.error).toHaveBeenCalled()
  })
})

describe('stores/group —— createGroup', () => {
  it('非法输入直接抛校验错误，不落痕不外呼', async () => {
    const store = await freshStore()
    await expect(store.createGroup({ ...draft, groupName: '', members: [] })).rejects.toThrow('请填写群名称')
    expect(repoMock.createJob).not.toHaveBeenCalled()
    expect(portMock.createGroup).not.toHaveBeenCalled()
  })

  it('成功：返回终态任务并推进历史版本号（历史 Tab 依赖它重载）', async () => {
    repoMock.createJob.mockResolvedValue(jobOf())
    const store = await freshStore()
    const before = store.historyVersion
    const job = await store.createGroup(draft)
    expect(job).toMatchObject({ status: 'success', groupId: 'G-1' })
    expect(store.historyVersion).toBe(before + 1)
    expect(store.creating).toBe(false)
  })

  it('失败：错误落痕、版本号照样推进（历史要显示 failed 行）', async () => {
    repoMock.createJob.mockResolvedValue(jobOf())
    portMock.createGroup.mockRejectedValue(new Error('成员不存在'))
    const store = await freshStore()
    const before = store.historyVersion
    const job = await store.createGroup(draft)
    expect(job.status).toBe('failed')
    expect(repoMock.failJob).toHaveBeenCalledWith(7, '成员不存在')
    expect(store.historyVersion).toBe(before + 1)
  })

  it('外呼期间 creating=true（按钮 loading 的数据源），结束必复位', async () => {
    let release!: () => void
    repoMock.createJob.mockResolvedValue(jobOf())
    portMock.createGroup.mockImplementation(
      () =>
        new Promise<{ groupId: string }>((resolve) => {
          release = () => resolve({ groupId: 'G-1' })
        }),
    )
    const store = await freshStore()
    const pending = store.createGroup(draft)
    // createJob → port.createGroup 之间隔了若干微任务，先放行一轮再断言在途状态
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(store.creating).toBe(true)
    release()
    await pending
    expect(store.creating).toBe(false)
  })
})

describe('stores/group —— 模板与历史', () => {
  it('saveTemplate 分流：无 pk 走新建，有 pk 走更新', async () => {
    const store = await freshStore()
    await store.saveTemplate({ name: 'a', groupName: 'a', members: ['E-1'] })
    expect(repoMock.createTemplate).toHaveBeenCalled()
    await store.saveTemplate({ name: 'a', groupName: 'a', members: ['E-1'] }, 5)
    expect(repoMock.updateTemplate).toHaveBeenCalledWith(5, expect.anything())
  })

  it('saveTemplate 更新不命中时上抛（模板已被删）', async () => {
    repoMock.updateTemplate.mockResolvedValue(false)
    const store = await freshStore()
    await expect(store.saveTemplate({ name: 'a', groupName: 'a', members: ['E-1'] }, 5)).rejects.toThrow('#5')
  })

  it('removeTemplate / removeJob 不命中时上抛，命中时推进版本号', async () => {
    const store = await freshStore()
    await store.removeTemplate(3)
    expect(repoMock.removeTemplate).toHaveBeenCalledWith(3)

    repoMock.removeJob.mockResolvedValue(false)
    await expect(store.removeJob(9)).rejects.toThrow('#9')

    repoMock.removeJob.mockResolvedValue(true)
    const before = store.historyVersion
    await store.removeJob(9)
    expect(store.historyVersion).toBe(before + 1)
  })

  it('历史查询直通（筛选与分页由视图持有）', async () => {
    repoMock.listJobs.mockResolvedValue([jobOf()])
    const store = await freshStore()
    const rows = await store.listJobs({ keyword: '周会', limit: 10, offset: 0 })
    expect(rows).toHaveLength(1)
    expect(repoMock.listJobs).toHaveBeenCalledWith({ keyword: '周会', limit: 10, offset: 0 })
    expect(await store.countJobs({ keyword: '周会' })).toBe(0)
  })
})
