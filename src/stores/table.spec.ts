import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

import type { TableRow, TableRowDraft } from '@/types'

/**
 * store 测试：注入内存假后端（模拟 SQL 仓储语义），验证 store 的状态机：
 * load/CRUD/筛选/分页/统计。后端自身的 SQL 拼接在 records.spec.ts 单测。
 */

function seedRows(): TableRow[] {
  return [
    { id: 3, name: '离线报表任务', category: '数据服务', status: 'inactive', amount: 7400, owner: '王强', createdAt: '2026-02-03' },
    { id: 2, name: '订单查询服务', category: '业务应用', status: 'active', amount: 35600, owner: '李娜', createdAt: '2026-01-22' },
    { id: 1, name: '日志采集网关', category: '基础设施', status: 'active', amount: 12800, owner: '张伟', createdAt: '2026-01-08' },
  ]
}

// vi.mock 工厂会被提升到文件顶部，其闭包引用的变量必须一起 hoisted，
// 否则 "Cannot access 'fakeBackend' before initialization"。
const { fakeBackend, resetRows } = vi.hoisted(() => {
  let backendRows: import('@/types').TableRow[] = []
  const init = () => {
    backendRows = [
      { id: 3, name: '离线报表任务', category: '数据服务', status: 'inactive', amount: 7400, owner: '王强', createdAt: '2026-02-03' },
      { id: 2, name: '订单查询服务', category: '业务应用', status: 'active', amount: 35600, owner: '李娜', createdAt: '2026-01-22' },
      { id: 1, name: '日志采集网关', category: '基础设施', status: 'active', amount: 12800, owner: '张伟', createdAt: '2026-01-08' },
    ]
  }
  init()
  const fake = {
    prepare: vi.fn(async () => undefined),
    loadAll: vi.fn(async () => backendRows.map((row) => ({ ...row }))),
    insert: vi.fn(async (draft: import('@/types').TableRowDraft) => {
      const row = { ...draft, id: 100, createdAt: '2026-09-24' }
      backendRows.unshift(row)
      return { ...row }
    }),
    update: vi.fn(async (id: number, draft: import('@/types').TableRowDraft) => {
      const target = backendRows.find((row) => row.id === id)
      if (target) Object.assign(target, draft)
    }),
    remove: vi.fn(async (ids: number[]) => {
      backendRows = backendRows.filter((row) => !ids.includes(row.id))
    }),
    resetSeed: vi.fn(async () => {
      init()
      return backendRows.map((row) => ({ ...row }))
    }),
  }
  return { fakeBackend: fake, resetRows: init }
})

vi.mock('@/repositories/records', async () => {
  const actual = await vi.importActual<typeof import('@/repositories/records')>('@/repositories/records')
  return {
    ...actual,
    recordsBackend: fakeBackend,
    cloneSeed: () => seedRows(),
  }
})

vi.mock('@/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

import { useTableStore } from '@/stores/table'

describe('table store（后端注入假件）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    resetRows()
  })

  it('初始 rows 为空，load 后填充且 loaded 置位', async () => {
    const store = useTableStore()
    expect(store.rows).toHaveLength(0)
    expect(store.loaded).toBe(false)

    await store.load()
    expect(fakeBackend.prepare).toHaveBeenCalledTimes(1)
    expect(fakeBackend.loadAll).toHaveBeenCalledTimes(1)
    expect(store.rows).toHaveLength(3)
    expect(store.loaded).toBe(true)
  })

  it('load 失败时使用种子兜底且不抛', async () => {
    fakeBackend.loadAll.mockRejectedValueOnce(new Error('db down'))
    const store = useTableStore()
    await store.load()
    expect(store.rows).toHaveLength(3)
    expect(store.loaded).toBe(true)
  })

  describe('筛选与分页（纯本地状态）', () => {
    it('关键字命中名称或负责人；与分类是 AND；空条件全量', async () => {
      const store = useTableStore()
      await store.load()

      store.keyword = '网关'
      expect(store.filtered.map((r) => r.id)).toEqual([1])

      store.keyword = '王强'
      store.category = '数据服务'
      expect(store.filtered).toHaveLength(1)
      store.category = '业务应用'
      expect(store.filtered).toHaveLength(0)

      store.keyword = ''
      store.category = ''
      expect(store.filtered).toHaveLength(3)
    })

    it('筛选变化自动回到第 1 页', async () => {
      const { nextTick } = await import('vue')
      const store = useTableStore()
      await store.load()
      store.pageSize = 2
      store.page = 2
      store.keyword = '服务'
      await nextTick()
      expect(store.page).toBe(1)
    })

    it('total=0 时 pageCount 至少为 1（除零护栏）', async () => {
      const store = useTableStore()
      await store.load()
      store.keyword = '绝不存在的关键词zzz'
      expect(store.total).toBe(0)
      expect(store.pageCount).toBe(1)
    })

    it('paged 按页切片', async () => {
      const store = useTableStore()
      await store.load()
      store.pageSize = 2
      store.page = 2
      expect(store.paged.map((r) => r.id)).toEqual([1])
    })
  })

  describe('CRUD 走后端且更新本地状态', () => {
    const draft: TableRowDraft = { name: '新项目', category: '数据服务', status: 'active', amount: 100, owner: '测试员' }

    it('create 调后端 insert、行插到队首、重置页码', async () => {
      const store = useTableStore()
      await store.load()
      store.page = 2

      await store.create(draft)
      expect(fakeBackend.insert).toHaveBeenCalledWith(draft)
      expect(store.rows[0]).toMatchObject({ id: 100, name: '新项目', createdAt: '2026-09-24' })
      expect(store.page).toBe(1)
    })

    it('create 后端失败时抛错且不改本地状态', async () => {
      const store = useTableStore()
      await store.load()
      fakeBackend.insert.mockRejectedValueOnce(new Error('constraint failed'))
      await expect(store.create(draft)).rejects.toThrow('constraint failed')
      expect(store.rows).toHaveLength(3)
    })

    it('update 成功后就地合并，未知 id 后端 no-op 本地也不炸', async () => {
      const store = useTableStore()
      await store.load()
      await store.update(1, { ...draft, name: '改名了' })
      expect(store.rows.find((r) => r.id === 1)?.name).toBe('改名了')
      await store.update(99999, draft)
      expect(store.rows).toHaveLength(3)
    })

    it('remove 成功后过滤并把越界页码收回；空数组 no-op 不打后端', async () => {
      const store = useTableStore()
      await store.load()
      store.pageSize = 2
      store.page = 2

      await store.remove([3, 2])
      expect(store.rows.map((r) => r.id)).toEqual([1])
      expect(store.page).toBe(1)

      const calls = fakeBackend.remove.mock.calls.length
      await store.remove([])
      expect(fakeBackend.remove.mock.calls.length).toBe(calls)
    })

    it('resetSeed 调后端并清筛选/页码', async () => {
      const store = useTableStore()
      await store.load()
      store.keyword = 'x'
      store.category = '数据服务'
      store.page = 2

      await store.resetSeed()
      expect(fakeBackend.resetSeed).toHaveBeenCalledTimes(1)
      expect(store.rows).toHaveLength(3)
      expect(store.keyword).toBe('')
      expect(store.category).toBe('')
      expect(store.page).toBe(1)
    })
  })

  describe('派生统计', () => {
    it('stats 汇总全量行（不受筛选影响）', async () => {
      const store = useTableStore()
      await store.load()
      store.keyword = '网关'
      expect(store.stats).toEqual({ total: 3, active: 2, inactive: 1, amount: 55800 })
    })

    it('recent 按 id 降序取 5，不改动 rows', async () => {
      const store = useTableStore()
      await store.load()
      expect(store.recent.map((r) => r.id)).toEqual([3, 2, 1])
      expect(store.rows.map((r) => r.id)).toEqual([3, 2, 1])
    })
  })
})