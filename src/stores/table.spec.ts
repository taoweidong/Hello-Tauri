import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'

// mock bridge —— table store 通过 @/api 引用宿主，测试时全部打桩。
// 显式标注可 resolve string 的 fn，否则 vi.fn(async () => null) 会把返回类型
// 窄化成 Promise<null>，后面 mockResolvedValueOnce(str) 触发 TS2345。
const bridge = vi.hoisted(() => ({
  platform: 'web',
  loadConfig: vi.fn<() => Promise<string | null>>(async () => null),
  saveConfig: vi.fn<(c: string) => Promise<void>>(async () => undefined),
  readTable: vi.fn<() => Promise<string | null>>(async () => null),
  writeTable: vi.fn<(c: string) => Promise<void>>(async () => undefined),
  appendLog: vi.fn<(l: string, m: string) => Promise<string>>(async () => 'memory://log'),
  storageInfo: vi.fn(async () => ({
    root: 'memory://',
    preferredRoot: 'D:\\TangYuan',
    configFile: '',
    tableFile: '',
    logsDir: '',
    fallback: true,
    note: 'test',
  })),
  openStorageDir: vi.fn(async () => undefined),
  appInfo: vi.fn(async () => ({
    name: 'test',
    version: '0.0.0',
    tauriVersion: '-',
    platform: 'web',
    arch: '-',
    configPath: '',
    storage: {},
  })),
}))

vi.mock('@/api', () => ({ bridge, platform: 'web' }))

import { useTableStore } from '@/stores/table'

function seedIds(store: ReturnType<typeof useTableStore>) {
  return store.rows.map((row) => row.id)
}

describe('table store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
  })

  it('初始为 12 条示例数据，loaded 未就绪', () => {
    const store = useTableStore()
    expect(store.rows).toHaveLength(12)
    expect(store.loaded).toBe(false)
  })

  it('filtered 关键字命中名称或负责人（大小写不敏感）', () => {
    const store = useTableStore()
    store.keyword = '日志'
    expect(store.filtered.every((r) => r.name.includes('日志') || r.owner.includes('日志'))).toBe(true)
    expect(store.filtered.length).toBeGreaterThan(0)

    store.keyword = 'zhang'
    expect(store.filtered).toHaveLength(0)

    store.keyword = ' 张伟 '
    expect(store.filtered.map((r) => r.name)).toEqual(['日志采集网关'])
  })

  it('关键字与分类是 AND 关系', () => {
    const store = useTableStore()
    store.keyword = '网关'
    store.category = '数据服务'
    expect(store.filtered).toHaveLength(0)
    store.category = '基础设施'
    expect(store.filtered).toHaveLength(1)
  })

  it('空筛选返回全量', () => {
    const store = useTableStore()
    expect(store.filtered).toHaveLength(12)
  })

  describe('分页', () => {
    it('pageCount 向上取整，且 total=0 时至少为 1（除零护栏）', () => {
      const store = useTableStore()
      store.pageSize = 5
      expect(store.pageCount).toBe(3)
      store.keyword = '绝不存在的关键词zzz'
      expect(store.total).toBe(0)
      expect(store.pageCount).toBe(1)
    })

    it('paged 按页切片', () => {
      const store = useTableStore()
      store.pageSize = 5
      store.page = 2
      expect(store.paged.map((r) => r.id)).toEqual([6, 7, 8, 9, 10])
      store.page = 3
      expect(store.paged.map((r) => r.id)).toEqual([11, 12])
    })

    it('keyword/pageSize 变更后页码语义正确：筛选变化重置到第 1 页', async () => {
      const store = useTableStore()
      store.page = 2
      store.keyword = '网关'
      await nextTick()
      await nextTick()
      expect(store.page).toBe(1)
    })
  })

  describe('CRUD', () => {
    const draft = { name: '新项目', category: '数据服务', status: 'active' as const, amount: 100, owner: '测试员' }

    it('create 插入队首、重置页码、ID 单调递增', () => {
      const store = useTableStore()
      store.create(draft)
      expect(store.rows[0].name).toBe('新项目')
      expect(store.rows[0].id).toBe(13)
      expect(store.rows[0].createdAt).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    })

    it('删除最大 ID 后新增不复用该 ID（回归测试）', () => {
      const store = useTableStore()
      const maxId = Math.max(...seedIds(store))
      store.remove([maxId])
      store.create(draft)
      expect(store.rows[0].id).toBe(maxId + 1)
    })

    it('update 就地修改目标行，找不到 id 时静默不炸', () => {
      const store = useTableStore()
      store.update(1, { ...draft, name: '改名了' })
      expect(store.rows.find((r) => r.id === 1)?.name).toBe('改名了')
      expect(() => store.update(99999, draft)).not.toThrow()
    })

    it('remove 批量删除并把越界页码收回最后一页', () => {
      const store = useTableStore()
      store.pageSize = 5
      store.page = 3
      store.remove(seedIds(store).filter((id) => id > 2))
      expect(store.rows).toHaveLength(2)
      expect(store.page).toBeLessThanOrEqual(store.pageCount)
    })

    it('remove 空数组为 no-op', () => {
      const store = useTableStore()
      const before = store.rows.length
      store.remove([])
      expect(store.rows).toHaveLength(before)
    })
  })

  describe('stats / recent', () => {
    it('stats 与种子数据一致', () => {
      const store = useTableStore()
      expect(store.stats.total).toBe(12)
      expect(store.stats.active).toBe(9)
      expect(store.stats.inactive).toBe(3)
      expect(store.stats.amount).toBe(309100)
    })

    it('recent 按 id 降序取 5 条，不改动原数组', () => {
      const store = useTableStore()
      const first = store.rows[0].id
      expect(store.recent.map((r) => r.id)).toEqual([12, 11, 10, 9, 8])
      expect(store.rows[0].id).toBe(first)
    })
  })

  describe('持久化守卫（loaded 前不回写）', () => {
    it('load 之前 rows 变更不触发 writeTable', async () => {
      const store = useTableStore()
      store.create(draftish())
      await nextTick()
      await nextTick()
      expect(bridge.writeTable).not.toHaveBeenCalled()
    })

    it('load 之后 rows 变更触发 writeTable（深度 watch）', async () => {
      bridge.readTable.mockResolvedValueOnce(JSON.stringify([{ id: 1, name: 'a', category: 'x', status: 'active', amount: 1, owner: 'o', createdAt: '2026-01-01' }]))
      const store = useTableStore()
      await store.load()
      expect(store.rows).toHaveLength(1)
      expect(store.loaded).toBe(true)

      store.create(draftish())
      await nextTick()
      await nextTick()
      expect(bridge.writeTable).toHaveBeenCalledTimes(1)
      const written = JSON.parse(bridge.writeTable.mock.calls[0][0] as string)
      expect(written).toHaveLength(2)
    })

    it('load 读到坏 JSON 时保持示例数据且不抛异常', async () => {
      bridge.readTable.mockResolvedValueOnce('{ not json')
      const store = useTableStore()
      await expect(store.load()).resolves.toBeUndefined()
      expect(store.rows).toHaveLength(12)
    })

    it('load 恢复 nextIdSeed，删尾增新不撞已用 ID', async () => {
      bridge.readTable.mockResolvedValueOnce(
        JSON.stringify([
          { id: 100, name: 'a', category: 'x', status: 'active', amount: 1, owner: 'o', createdAt: '2026-01-01' },
        ]),
      )
      const store = useTableStore()
      await store.load()
      store.remove([100])
      store.create(draftish())
      expect(store.rows[0].id).toBe(101)
    })
  })

  describe('resetSeed', () => {
    it('恢复示例数据并清空筛选与页码', () => {
      const store = useTableStore()
      store.remove([1, 2, 3])
      store.keyword = 'xx'
      store.category = '基础设施'
      store.page = 2
      store.resetSeed()
      expect(store.rows).toHaveLength(12)
      expect(store.keyword).toBe('')
      expect(store.category).toBe('')
      expect(store.page).toBe(1)
      expect(Math.max(...seedIds(store))).toBe(12)
    })
  })
})

function draftish() {
  return { name: '新项目', category: '数据服务', status: 'active' as const, amount: 100, owner: '测试员' }
}