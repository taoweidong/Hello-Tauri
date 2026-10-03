import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { WelinkRepository } from '@/infra/db'

/**
 * 存储网关（D2）：纯委托语义验证 —— 幂等迁移透传、仓储单例透传、
 * 测试注入（setWelinkRepository）在网关之后仍然生效。
 */

const { migrateMock, dbState } = vi.hoisted(() => ({
  migrateMock: vi.fn(async (): Promise<number[]> => [1, 2, 3]),
  dbState: { repo: null as unknown },
}))

vi.mock('@/infra/db', () => ({
  dbMigrateAll: () => migrateMock(),
  welink: () => dbState.repo,
  setWelinkRepository: (repo: unknown) => {
    dbState.repo = repo
  },
}))

async function freshGateway() {
  vi.resetModules()
  return import('./welink-storage')
}

describe('orchestrator/welink-storage 网关', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    dbState.repo = { listConversations: vi.fn(async () => []) }
  })

  it('ensureWelinkStorage 委托 dbMigrateAll 并透传结果', async () => {
    const gw = await freshGateway()
    await expect(gw.ensureWelinkStorage()).resolves.toEqual([1, 2, 3])
    expect(migrateMock).toHaveBeenCalledTimes(1)
  })

  it('getWelinkRepo 委托 welink() 工厂（浏览器模式内存实现的装配点保持在 infra 层）', async () => {
    const gw = await freshGateway()
    expect(gw.getWelinkRepo()).toBe(dbState.repo)
  })

  it('测试注入（setWelinkRepository）在网关之后仍然生效 —— 网关不缓存仓储引用', async () => {
    const gw = await freshGateway()
    const { setWelinkRepository } = await import('@/infra/db')
    const injected = { listConversations: vi.fn(async () => []) } as unknown as WelinkRepository
    setWelinkRepository(injected)
    expect(gw.getWelinkRepo()).toBe(injected)
    setWelinkRepository(null)
  })
})
