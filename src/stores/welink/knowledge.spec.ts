import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

/**
 * 知识库 × 知识沉淀 store 单测（第二轮补缺口，N2）。
 *
 * 为什么必须补：`stores/welink/knowledge.ts` 此前 71% lines / **54% functions**
 * —— 一半的动作（保存/下架/登记/评审驳回/立即提取）从未被触达。它是
 * `knowledge/*.md`（本项目**唯一的长期记忆落点**）的 UI 面，评审动作一旦在
 * store 层接错（失败也刷新、并发重复提取），用户的直观感受是「我写进去的东西不见了」。
 *
 * 这里钉的四件事：
 *  1. 清单类动作（saveDoc/offShelf/registerDoc）**成功才刷新**，不是无条件刷新；
 *  2. 评审通过/驳回按 harvester 的返回值决定是否刷新（失败不刷，避免「看着成功了其实没写」）；
 *  3. `runOnce()` 的 busy 互斥与 `finally` 复位（连点不能跑两轮）；
 *  4. `fsAvailable` 在浏览器模式为 false（Web 调试时不得假装能写文件）。
 */

const fakes = vi.hoisted(() => {
  const port = {
    listDocs: vi.fn(async () => [] as unknown[]),
    saveDoc: vi.fn(async (input: unknown) => ({ file: 'a.md', title: 'A', ...(input as object) })),
    readDoc: vi.fn(async () => '正文' as string | null),
    offShelf: vi.fn(async () => true),
    registerDoc: vi.fn(async (input: unknown) => ({ file: 'b.md', title: 'B', ...(input as object) })),
  }
  const sediment = {
    listDrafts: vi.fn(async () => [] as unknown[]),
    listSedimentLogs: vi.fn(async () => [] as unknown[]),
  }
  const harvester = {
    approve: vi.fn(async () => true),
    reject: vi.fn(async () => true),
    runOnce: vi.fn(async () => ({ extracted: 2, drafts: 1, archived: 0 })),
  }
  return {
    port,
    sediment,
    harvester,
    state: { platform: 'tauri' as 'tauri' | 'web', ensureRuntimeRejects: false },
  }
})

vi.mock('@/api', () => ({
  get platform() {
    return fakes.state.platform
  },
}))
vi.mock('@/infra/knowledge', () => ({ knowledgePort: () => fakes.port }))
vi.mock('@/infra/db', () => ({ sediment: () => fakes.sediment }))
vi.mock('./index', () => ({
  useWelinkStore: () => ({
    ensureRuntime: async () => {
      if (fakes.state.ensureRuntimeRejects) throw new Error('运行时装配失败')
      return { harvester: fakes.harvester }
    },
  }),
}))

async function fresh() {
  vi.resetModules()
  const mod = await import('./knowledge')
  setActivePinia(createPinia())
  return mod.useKnowledgeStore()
}

const DOC = { file: 'a.md', title: 'A', source: 'manual' as const, updatedAt: 't', size: 10 }

describe('stores/welink/knowledge —— 知识库清单', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    fakes.state.platform = 'tauri'
    fakes.state.ensureRuntimeRejects = false
    fakes.port.listDocs.mockResolvedValue([DOC])
    fakes.port.readDoc.mockResolvedValue('正文')
    fakes.sediment.listDrafts.mockResolvedValue([])
    fakes.sediment.listSedimentLogs.mockResolvedValue([])
  })

  it('loadDocs 填清单并把 docsLoaded 置真（首次进入面板不再重复拉取的判据）', async () => {
    const store = await fresh()
    await store.loadDocs()
    expect(store.docs).toHaveLength(1)
    expect(store.docsLoaded).toBe(true)
  })

  it('saveDoc 落盘后刷新清单（新建/覆盖都走同一出口）', async () => {
    const store = await fresh()
    const entry = await store.saveDoc({ file: 'a.md', title: 'A', content: 'x', source: 'manual' })
    expect(entry.file).toBe('a.md')
    expect(fakes.port.listDocs).toHaveBeenCalledTimes(1)
    expect(store.docs).toHaveLength(1)
  })

  it('readDoc 返回正文；文件已被移走时为 null（UI 据此给「文件不存在」提示）', async () => {
    const store = await fresh()
    await expect(store.readDoc('a.md')).resolves.toBe('正文')
    fakes.port.readDoc.mockResolvedValue(null)
    await expect(store.readDoc('gone.md')).resolves.toBeNull()
  })

  it('offShelf / registerDoc 后都刷新清单（下架与登记都是清单变更）', async () => {
    const store = await fresh()
    await expect(store.offShelf('a.md')).resolves.toBe(true)
    await store.registerDoc({ file: 'b.md', title: 'B' })
    expect(fakes.port.listDocs).toHaveBeenCalledTimes(2)
  })

  it('fsAvailable 在桌面为真、浏览器为假（Web 调试不得假装能写知识库）', async () => {
    const store = await fresh()
    expect(store.fsAvailable).toBe(true)
    fakes.state.platform = 'web'
    const webStore = await fresh()
    expect(webStore.fsAvailable).toBe(false)
  })
})

describe('stores/welink/knowledge —— 评审闸', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    fakes.state.platform = 'tauri'
    fakes.port.listDocs.mockResolvedValue([DOC])
    fakes.sediment.listDrafts.mockResolvedValue([{ pk: 1, title: '候选' }])
    fakes.sediment.listSedimentLogs.mockResolvedValue([])
    fakes.harvester.approve.mockResolvedValue(true)
    fakes.harvester.reject.mockResolvedValue(true)
  })

  it('loadDrafts 只拉 pending 且带工作集上限（评审队列不是归档，量级小）', async () => {
    const store = await fresh()
    await store.loadDrafts()
    expect(fakes.sediment.listDrafts).toHaveBeenCalledWith({ status: 'pending', limit: 50, offset: 0 })
    expect(store.draftCount).toBe(1)
  })

  it('approveDraft 成功 → 刷新队列与知识库清单；返回 false → 一次都不刷', async () => {
    const store = await fresh()
    await expect(store.approveDraft(1, { title: 'T', content: 'C' })).resolves.toBe(true)
    expect(fakes.port.listDocs).toHaveBeenCalledTimes(1)
    expect(fakes.sediment.listDrafts).toHaveBeenCalledTimes(1)
    expect(fakes.harvester.approve).toHaveBeenCalledWith(1, { title: 'T', content: 'C' }, undefined)

    fakes.harvester.approve.mockResolvedValue(false)
    await expect(store.approveDraft(2, { title: 'T', content: 'C' })).resolves.toBe(false)
    expect(fakes.port.listDocs).toHaveBeenCalledTimes(1) // 没多刷
    expect(fakes.sediment.listDrafts).toHaveBeenCalledTimes(1)
  })

  it('rejectDraft 成功才刷新队列；失败不刷（驳回也要留痕，不能静默吞）', async () => {
    const store = await fresh()
    await expect(store.rejectDraft(1, '不采纳')).resolves.toBe(true)
    expect(fakes.sediment.listDrafts).toHaveBeenCalledTimes(1)
    expect(fakes.harvester.reject).toHaveBeenCalledWith(1, '不采纳')

    fakes.harvester.reject.mockResolvedValue(false)
    await expect(store.rejectDraft(2, '不采纳')).resolves.toBe(false)
    expect(fakes.sediment.listDrafts).toHaveBeenCalledTimes(1)
  })

  it('评审走 harvester（唯一收口「写知识库 + 置终态」的地方），不是 store 自己写文件', async () => {
    const store = await fresh()
    await store.approveDraft(1, { title: 'T', content: 'C' }, { file: 'target.md' })
    expect(fakes.harvester.approve).toHaveBeenCalledWith(1, { title: 'T', content: 'C' }, { file: 'target.md' })
    expect(fakes.port.saveDoc).not.toHaveBeenCalled()
  })
})

describe('stores/welink/knowledge —— 立即提取一轮', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    fakes.state.platform = 'tauri'
    fakes.state.ensureRuntimeRejects = false
    fakes.port.listDocs.mockResolvedValue([DOC])
    fakes.sediment.listDrafts.mockResolvedValue([])
    fakes.sediment.listSedimentLogs.mockResolvedValue([{ pk: 9 }])
    fakes.harvester.runOnce.mockResolvedValue({ extracted: 2, drafts: 1, archived: 0 })
  })

  it('runOnce 成功后写 lastReport 并刷新队列/清单/留痕', async () => {
    const store = await fresh()
    const report = await store.runOnce()
    expect(report).toEqual({ extracted: 2, drafts: 1, archived: 0 })
    expect(store.lastReport).toEqual({ extracted: 2, drafts: 1, archived: 0 })
    expect(fakes.sediment.listSedimentLogs).toHaveBeenCalledWith(20)
    expect(store.logs).toHaveLength(1)
    expect(store.busy).toBe(false)
  })

  it('busy 互斥：在飞时第二次调用返回 null（连点按钮不会跑两轮）', async () => {
    const store = await fresh()
    const first = store.runOnce()
    await expect(store.runOnce()).resolves.toBeNull()
    await first
    expect(fakes.harvester.runOnce).toHaveBeenCalledTimes(1)
    expect(store.busy).toBe(false)
  })

  it('runOnce 抛错时 busy 在 finally 复位（否则按钮永久禁用，表现为「点了没反应」）', async () => {
    fakes.harvester.runOnce.mockRejectedValue(new Error('提取失败'))
    const store = await fresh()
    await expect(store.runOnce()).rejects.toThrow('提取失败')
    expect(store.busy).toBe(false)
    // 复位后可再次发起（不是一次性锁死）
    fakes.harvester.runOnce.mockResolvedValue({ extracted: 0, drafts: 0, archived: 0 })
    await expect(store.runOnce()).resolves.toBeTruthy()
  })

  it('运行时装配失败时 runOnce 抛出且 busy 复位（不把失败伪装成空报告）', async () => {
    fakes.state.ensureRuntimeRejects = true
    const store = await fresh()
    await expect(store.runOnce()).rejects.toThrow('运行时装配失败')
    expect(store.busy).toBe(false)
    expect(store.lastReport).toBeNull()
  })
})
