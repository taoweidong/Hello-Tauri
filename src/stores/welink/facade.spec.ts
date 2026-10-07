import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

/**
 * welink store 的轮询节奏派生（D-6）。
 *
 * 只测这一个派生函数，不测整个 store：`pollPlan` 的全部价值在于**「页面上的数字
 * 必须是真的」**，而它的三种数据来源（实测 / 预估 / 不可知）恰好分别对应三种
 * 容易说谎的情形。把这三条钉住，比再抄一遍 `planPollRound` 的单测更有意义
 * （后者已在 `utils/poll.spec.ts` 覆盖）。
 */

const { repoMock } = vi.hoisted(() => ({
  repoMock: {
    // 返回类型必须显式给出：`async () => []` 会被推断为 `never[]`，
    // 之后 `mockResolvedValue([conversation(true)])` 就会报「不能赋给 never」。
    listConversations: vi.fn(async (_limit?: number): Promise<unknown[]> => []),
    countConversations: vi.fn(async (): Promise<number> => 0),
    listUnfinishedJobs: vi.fn(async (): Promise<unknown[]> => []),
    countHolding: vi.fn(async (): Promise<number> => 0),
    listJobs: vi.fn(async (): Promise<unknown[]> => []),
    countSentSince: vi.fn(async (): Promise<number> => 0),
    countGlobalSentSince: vi.fn(async (): Promise<number> => 0),
    lastSentAt: vi.fn(async (): Promise<string | null> => null),
  },
}))

vi.mock('@/infra/db', () => ({
  welink: () => repoMock,
  dbMigrateAll: vi.fn(async () => []),
}))
vi.mock('@/utils/logger', async (importOriginal) => {
  // 部分 mock：保留 registerSecret / resetSecretsForTest 等真实导出。
  // 本文件走 applySettings → registerWelinkSecrets 路径，需要真实的遮蔽注册表；
  // 全量替换写法会让新增导出「缺一个就报No xxx export is defined」，
  // 逼着每个测试文件跟着业务代码的导出列表走。
  const actual = await importOriginal<typeof import('@/utils/logger')>()
  return {
    ...actual,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    onLog: vi.fn(() => () => {}),
  }
})

async function freshStore() {
  vi.resetModules()
  const { useWelinkStore } = await import('@/stores/welink')
  return useWelinkStore()
}

function conversation(watching: boolean) {
  return {
    pk: 1,
    convType: 'group' as const,
    convId: 'G-1',
    title: '研发一组',
    remark: '',
    watching,
    autoReply: true,
    muteUntil: null,
    lastMsgAt: '',
    unreadCount: 0,
    mentionCount: 0,
    lastActive: '',
    lastCursor: '',
    updatedAt: '',
  }
}

describe('stores/welink —— pollPlan（D-6：设置页显示的数字必须是真的）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
  })

  // 这两条用例各自 freshStore()：vi.resetModules() 会重导入整张 store 依赖图，
  // 在全量并发（多 worker 满载）时偶发超过默认 5s 预算。给**纯导入型**用例单独
  // 放宽到 20s —— 断言不变，只是给「加载」本身一个真实机器预算（个人工作台归档后
  // 套件新增组件挂载用例，单 worker 负载上升，此预算按实测校准）。
  it('**未装载会话清单时不冒充「0 个会话」**（known=false）', { timeout: 20_000 }, async () => {
    const store = await freshStore()
    const plan = store.pollPlan(5)
    expect(plan.known).toBe(false)
    // 会话数不可知时不能给出「0 个会话、周期 5s」这种听起来确定的错话
    expect(plan.conversationCount).toBe(0)
    // 但间隔本身仍然是配置真值，可以照实显示
    expect(plan.periodMs).toBe(5000)
  })

  it('装载后按监控会话数给出预估（known=true）', { timeout: 20_000 }, async () => {
    const store = await freshStore()
    repoMock.listConversations.mockResolvedValue([conversation(true), conversation(true), conversation(true)])
    await store.loadConversations()
    const plan = store.pollPlan(5)
    expect(plan.known).toBe(true)
    expect(plan.conversationCount).toBe(3)
    // 3 个会话 → 每会话 2000ms（预算 5000/2 够用）→ 周期 5s + 4s
    expect(plan.staggerMs).toBe(2000)
    expect(plan.periodMs).toBe(9000)
  })

  it('只统计**监控中**的会话（未监控的不参与轮询）', async () => {
    const store = await freshStore()
    repoMock.listConversations.mockResolvedValue([conversation(true), conversation(false), conversation(false)])
    await store.loadConversations()
    // 1 个监控会话 → 没有「之间」→ 无错峰
    expect(store.pollPlan(5).staggerMs).toBe(0)
    expect(store.pollPlan(5).conversationCount).toBe(1)
  })

  it('传入的间隔优先于已生效配置（用户拖数字时提示立刻跟着变）', async () => {
    const store = await freshStore()
    repoMock.listConversations.mockResolvedValue([conversation(true), conversation(true)])
    await store.loadConversations()
    expect(store.pollPlan(30).periodMs).toBe(30_000 + 2000)
    expect(store.pollPlan(5).periodMs).toBe(5000 + 2000)
  })

  it('多会话时标记收敛（UI 据此解释「间隔为何不是实际周期」）', async () => {
    const store = await freshStore()
    repoMock.listConversations.mockResolvedValue(Array.from({ length: 20 }, () => conversation(true)))
    await store.loadConversations()
    const plan = store.pollPlan(5)
    expect(plan.converged).toBe(true)
    expect(plan.staggerMs).toBe(300)
  })
})

// ---------------------------------------------------------------- 急停持久化（评审 P1）

/**
 * panic 原为 Gate 实例内的纯内存态：急停后重启，bootstrap 会按原 sendMode 恢复
 * 调度、ready 任务继续自动外发——最后防线静默失效。现在标记随配置落盘，
 * init 读到它时强制降为人工确认模式并复位。
 */
describe('stores/welink —— 急停跨重启不复活（评审 P1）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
  })

  it('init 读到落盘的 panicked 标记：强制 manual 并复位，返回 panicRecovered=true', async () => {
    const store = await freshStore()
    const report = await store.init({ panicked: true, sendMode: 'auto' })
    expect(report.panicRecovered).toBe(true)
    // 降级必须在恢复调度之前生效（视图拿到返回值后才 start）
    expect(store.settings.sendMode).toBe('manual')
    expect(store.settings.panicked).toBe(false)
  })

  it('无急停标记时正常初始化（panicRecovered=false，sendMode 不被改动）', async () => {
    const store = await freshStore()
    const report = await store.init({ sendMode: 'auto' })
    expect(report.panicRecovered).toBe(false)
    expect(store.settings.sendMode).toBe('auto')
    expect(store.settings.panicked).toBe(false)
  })
})
