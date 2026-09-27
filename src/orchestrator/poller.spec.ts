import { describe, expect, it, vi } from 'vitest'

/**
 * Poller 单测（设计 §13「假时钟验证 setTimeout 链、in-flight 锁、退避序列」）。
 *
 * Poller 的风险全在**调度语义**上，不在业务判定上：
 *  * 用 `setInterval` 会在「上一轮没跑完」时叠加请求 → 我们用 setTimeout 链；
 *  * 「立即拉取」与自动轮询若无共享锁，用户连点按钮就能打出并发 CLI 进程；
 *  * 退避若按全局而不是按会话，一个坏会话会拖慢所有好会话。
 *
 * 这里不依赖 `vi.useFakeTimers()`（那会与真实宏任务队列交互出难查的时序问题），
 * 而是注入一个**手动驱动的 TimerApi**：定时器排队，测试显式 `advance()` 触发。
 */

import { createPoller, filterSelf, BACKOFF_STEPS, COLD_EVERY, HOT_WINDOW_MS, WARM_EVERY } from '@/orchestrator/poller'
import type { ConversationState, EventSink, PollSummary, WelinkEvent } from '@/orchestrator/events'
import type { TimerApi } from '@/orchestrator/timers'
import type { WelinkRepository } from '@/infra/db/ports'
import type { PullResult } from '@/infra/welink/port'
import type { WelinkPort } from '@/infra/welink'
import {
  DEFAULT_WELINK_SETTINGS,
  type NormalizedMessage,
  type WelinkConversation,
  type WelinkSettings,
} from '@/types/welink'
import { parseStamp, nowStamp } from '@/utils/time'

// ---------------------------------------------------------------- 手动驱动的假时钟

/**
 * 可手动推进的调度器：`set` 只入队，`advance(ms)` 推进虚拟时间并触发到期回调。
 * 同时提供 `flush()` 让测试把微任务队列跑干净（轮询链里的 await 需要它）。
 */
function createScheduler() {
  let current = 0
  let seq = 0
  const pending = new Map<number, { at: number; handler: () => void }>()

  const timers: TimerApi = {
    set(handler, delayMs) {
      const id = ++seq
      pending.set(id, { at: current + Math.max(0, delayMs), handler })
      return id
    },
    clear(id) {
      if (typeof id === 'number') pending.delete(id)
    },
  }

  return {
    timers,
    /** 已排的定时器数量（断言「不再排」「只排一个」用） */
    get queued() {
      return pending.size
    },
    /**
     * 下一个到期时刻。
     *
     * 注意这是**绝对虚拟时刻**而非「还有多少毫秒」：`advance(5000)` 之后 `nextAt()`
     * 返回的是 10000 而不是 5000。断言「立即重排」要写成 `nextAt() === now()`。
     */
    nextAt(): number | null {
      const times = [...pending.values()].map((item) => item.at)
      return times.length ? Math.min(...times) : null
    },
    /** 当前虚拟时刻（配合 nextAt 判断「是不是排到了当下」） */
    now(): number {
      return current
    },
    /** 推进虚拟时间并触发所有到期回调 */
    advance(ms: number) {
      current += ms
      for (const [id, item] of [...pending.entries()]) {
        if (item.at <= current) {
          pending.delete(id)
          item.handler()
        }
      }
    },
    /** 清空所有已排定时器（不触发） */
    clearAll() {
      pending.clear()
    },
  }
}

/** 让所有已排的微任务跑完（真实 await 链需要） */
async function settle(rounds = 40) {
  for (let index = 0; index < rounds; index += 1) await Promise.resolve()
}

// ---------------------------------------------------------------- 夹具

function conversation(overrides: Partial<WelinkConversation> = {}): WelinkConversation {
  return {
    pk: 1,
    convType: 'group',
    convId: 'G-1001',
    title: '研发一组',
    remark: '',
    watching: true,
    autoReply: true,
    muteUntil: null,
    lastMsgAt: '',
    unreadCount: 0,
    mentionCount: 0,
    lastActive: '',
    lastCursor: '',
    updatedAt: '',
    ...overrides,
  }
}

function message(overrides: Partial<NormalizedMessage> = {}): NormalizedMessage {
  return {
    msgUid: 'm-1',
    convType: 'group',
    convId: 'G-1001',
    direction: 'in',
    senderId: 'E-9001',
    senderName: '赵敏',
    content: '@你 看下接口',
    msgType: 'text',
    atMe: true,
    sentAt: '2026-09-27 14:00:00',
    ...overrides,
  }
}

interface Harness {
  poller: ReturnType<typeof createPoller>
  scheduler: ReturnType<typeof createScheduler>
  events: WelinkEvent[]
  repo: {
    listWatching: ReturnType<typeof vi.fn>
    applyPollResult: ReturnType<typeof vi.fn>
  }
  pullMock: ReturnType<typeof vi.fn>
  /** 推进 `now()` 业务时钟（退避到期、分级判定的时间依据） */
  clockAdvance: (ms: number) => void
}

function harness(config: {
  conversations?: WelinkConversation[]
  settings?: Partial<WelinkSettings>
  pull?: (conv: WelinkConversation, after: string, limit: number) => Promise<PullResult>
  staggerMs?: number
  startedAt?: string
  /**
   * 是否每次 `listWatching()` 返回浅拷贝。
   *
   * 默认为 **true**：分级轮询的用例需要**稳定的夹具**。因为 poller 在拉到新数据后
   * 会回写 `conv.lastActive = nowStamp(now())`（这是有意的：会话有新数据就立刻变热），
   * 若沿用同一对象，「温会话第 2 轮应被跳过」这类断言会因为会话被上一轮焐热而失效。
   *
   * 想模拟「真实仓储每轮重新读库、能读到最新的 last_active」时显式传 false ——
   * 见「本会话拉到新数据后立刻变热」用例。
   */
  cloneConversations?: boolean
} = {}): Harness {
  const scheduler = createScheduler()
  const events: WelinkEvent[] = []
  const emit: EventSink = (event) => events.push(event)

  const conversations = config.conversations ?? [conversation()]
  const cloneConversations = config.cloneConversations ?? true
  const settings: WelinkSettings = {
    ...DEFAULT_WELINK_SETTINGS,
    myUserId: 'E-0001',
    enabled: true,
    pollIntervalSec: 5,
    ...config.settings,
  }

  const listWatching = vi.fn(async () =>
    cloneConversations ? conversations.map((item) => ({ ...item })) : conversations,
  )
  const applyPollResult = vi.fn(async (_convId: string, messages: NormalizedMessage[], cursor: string) => ({
    inserted: messages.map((item, index) => ({ ...item, pk: index + 1, convPk: 1, readFlag: false })),
    createdJobs: [],
    cursor,
  }))
  const repo = { listWatching, applyPollResult } as unknown as WelinkRepository

  let clockMs = parseStamp(config.startedAt ?? '2026-09-27 14:00:00')!.getTime()
  const pullMock = vi.fn(
    config.pull ??
      (async (conv: WelinkConversation, _after: string, _limit: number): Promise<PullResult> => ({
        messages: [message({ convId: conv.convId })],
        cursor: `c-${conv.convId}`,
        hasMore: false,
      })),
  )
  const port = { pull: pullMock, listConversations: vi.fn(), send: vi.fn() } as unknown as WelinkPort

  const poller = createPoller({
    repo,
    settings: () => settings,
    emit,
    timers: scheduler.timers,
    now: () => new Date(clockMs),
    staggerMs: config.staggerMs ?? 0,
    client: () => port,
  })

  return {
    poller,
    scheduler,
    events,
    repo: { listWatching, applyPollResult },
    pullMock,
    clockAdvance(ms: number) {
      clockMs += ms
    },
  }
}

const summaries = (events: WelinkEvent[]): PollSummary[] =>
  events.filter((event) => event.type === 'roundFinished').map((event) => (event as { summary: PollSummary }).summary)

const convStates = (events: WelinkEvent[]): ConversationState[] =>
  events.filter((event) => event.type === 'conversationState').map((event) => (event as { state: ConversationState }).state)

/**
 * 驱动「自动轮询」跑 n 轮。
 *
 * 为什么不能直接用 `pullNow()` 测分级轮询：手动拉取的 `manual=true` 会**绕过**
 * 分级判定（用户点按钮就是明确要看数据），分级只在自动轮询里生效。
 * 这里推进调度器触发链式的下一轮，让 roundNo 自然递增。
 */
async function autoRounds(h: Harness, count: number, intervalMs = 5000) {
  for (let index = 0; index < count; index += 1) {
    h.scheduler.advance(intervalMs)
    await settle()
  }
}

// ---------------------------------------------------------------- filterSelf

describe('orchestrator/poller —— filterSelf（自发消息改向而非丢弃）', () => {
  it('senderId == myUserId 的 in 消息被改成 out', () => {
    const result = filterSelf([message({ senderId: 'E-0001' })], 'E-0001')
    expect(result[0].direction).toBe('out')
  })

  it('他人的消息不受影响', () => {
    expect(filterSelf([message({ senderId: 'E-9001' })], 'E-0001')[0].direction).toBe('in')
  })

  it('已是 out 的保持 out（幂等）', () => {
    expect(filterSelf([message({ senderId: 'E-0001', direction: 'out' })], 'E-0001')[0].direction).toBe('out')
  })

  it('myUserId 为空时原样返回（不做无根据的过滤）', () => {
    const input = [message({ senderId: '' })]
    expect(filterSelf(input, '')[0]).toBe(input[0])
  })

  it('**不改内容也不丢消息**（R2 要求私聊双向可查）', () => {
    const input = [message({ senderId: 'E-0001', content: '我自己说的话' })]
    const result = filterSelf(input, 'E-0001')
    expect(result).toHaveLength(1)
    expect(result[0].content).toBe('我自己说的话')
  })
})

// ---------------------------------------------------------------- single-flight

describe('orchestrator/poller —— in-flight 锁（P2）', () => {
  it('并发 pullNow 只执行一轮（第二次被 in-flight 锁复用）', async () => {
    const h = harness()
    const first = h.poller.pullNow()
    const second = h.poller.pullNow()
    await Promise.all([first, second])
    // 两次调用拿到的是不同的 Promise 包装（`async` 函数返回新 Promise），
    // 但底层**只有一轮**真正执行 —— 这才是 single-flight 的语义
    expect(h.repo.listWatching).toHaveBeenCalledTimes(1)
    expect(h.pullMock).toHaveBeenCalledTimes(1)
    expect(h.poller.round()).toBe(1)
  })

  it('连点 5 次按钮只打一轮 CLI', async () => {
    const h = harness()
    await Promise.all(Array.from({ length: 5 }, () => h.poller.pullNow()))
    expect(h.pullMock).toHaveBeenCalledTimes(1)
  })

  it('自动轮询与手动拉取共用同一把锁', async () => {
    const h = harness()
    h.poller.start() // 首轮立刻跑（不等待）
    const manual = h.poller.pullNow()
    await manual
    // start 的首轮 + 手动请求被合并 → 只有一轮
    expect(h.repo.listWatching).toHaveBeenCalledTimes(1)
  })

  it('上一轮结束后锁释放，下一次可正常执行', async () => {
    const h = harness()
    await h.poller.pullNow()
    await h.poller.pullNow()
    expect(h.repo.listWatching).toHaveBeenCalledTimes(2)
  })

  it('一轮失败也不会锁死（finally 释放）', async () => {
    const h = harness({
      pull: async () => {
        throw new Error('CLI 炸了')
      },
    })
    await h.poller.pullNow()
    await expect(h.poller.pullNow()).resolves.toBeTruthy()
    expect(h.repo.listWatching).toHaveBeenCalledTimes(2)
  })
})

// ---------------------------------------------------------------- setTimeout 链

describe('orchestrator/poller —— setTimeout 链（不是 setInterval）', () => {
  it('start 立刻跑首轮（用户点开开关就该看到数据）', async () => {
    const h = harness()
    h.poller.start()
    await settle()
    expect(h.repo.listWatching).toHaveBeenCalledTimes(1)
  })

  it('start 幂等（重复调用不叠加定时器）', async () => {
    const h = harness()
    h.poller.start()
    await settle()
    h.poller.start()
    await settle()
    expect(h.repo.listWatching).toHaveBeenCalledTimes(1)
  })

  it('一轮**完成之后**才排下一轮（间隔从完成算起）', async () => {
    const h = harness()
    h.poller.start()
    await settle()
    // 首轮已完成 → 已排下一个定时器
    expect(h.scheduler.queued).toBe(1)
    expect(h.scheduler.nextAt()).toBe(5000)
  })

  it('推进一个间隔后跑第二轮', async () => {
    const h = harness()
    h.poller.start()
    await settle()
    h.scheduler.advance(5000)
    await settle()
    expect(h.repo.listWatching).toHaveBeenCalledTimes(2)
  })

  it('stop 后不再排下一轮，且已排的定时器被清掉', async () => {
    const h = harness()
    h.poller.start()
    await settle()
    h.poller.stop()
    expect(h.scheduler.queued).toBe(0)
    h.scheduler.advance(60_000)
    await settle()
    expect(h.repo.listWatching).toHaveBeenCalledTimes(1)
  })

  it('stop 后 running() 为 false，start 可重启', async () => {
    const h = harness()
    h.poller.start()
    await settle()
    h.poller.stop()
    expect(h.poller.running()).toBe(false)
    h.poller.start()
    await settle()
    expect(h.poller.running()).toBe(true)
    expect(h.repo.listWatching).toHaveBeenCalledTimes(2)
  })

  it('scheduleNext 先清旧句柄（不堆叠定时器）', async () => {
    const h = harness()
    h.poller.start()
    await settle()
    // 反复 refreshConversations 会重排下一轮，但队列里始终只有一个
    await h.poller.refreshConversations()
    await h.poller.refreshConversations()
    expect(h.scheduler.queued).toBe(1)
  })

  it('每轮发出 roundStarted / roundFinished 事件（轮次号递增）', async () => {
    const h = harness()
    await h.poller.pullNow()
    await h.poller.pullNow()
    const rounds = h.events.filter((event) => event.type === 'roundStarted').map((event) => (event as { round: number }).round)
    expect(rounds).toEqual([1, 2])
    expect(h.events.filter((event) => event.type === 'roundFinished')).toHaveLength(2)
    expect(h.poller.round()).toBe(2)
  })

  it('摘要统计本轮会话数与实际拉取数', async () => {
    const h = harness({ conversations: [conversation({ convId: 'G-1' }), conversation({ convId: 'G-2', pk: 2 })] })
    await h.poller.pullNow()
    expect(summaries(h.events)[0]).toMatchObject({ conversations: 2, polled: 2, inserted: 2, failed: 0 })
  })
})

// ---------------------------------------------------------------- 退避序列

describe('orchestrator/poller —— 退避序列（BACKOFF_STEPS）', () => {
  it('失败按步进退避：5 / 10 / 20 / 40 / 60 封顶', async () => {
    const h = harness({
      pull: async () => {
        throw new Error('持续失败')
      },
    })
    const seen: number[] = []
    for (let index = 0; index < 6; index += 1) {
      h.clockAdvance(60_000)
      await h.poller.pullNow()
      seen.push(h.poller.conversationState('G-1001').backoffSec)
    }
    expect(seen).toEqual([5, 10, 20, 40, 60, 60])
  })

  it('退避期的会话被跳过（手动拉取也尊重退避）', async () => {
    let failNext = 1
    const h = harness({
      pull: async (conv, _after, _limit) => {
        if (failNext > 0) {
          failNext -= 1
          throw new Error('偶发失败')
        }
        return { messages: [message({ convId: conv.convId })], cursor: `c-${conv.convId}`, hasMore: false }
      },
    })
    await h.poller.pullNow()
    expect(h.poller.conversationState('G-1001').state).toBe('backoff')
    // 退避未到期 → 第二轮跳过，不产生新的 pull
    await h.poller.pullNow()
    expect(h.pullMock).toHaveBeenCalledTimes(1)
    expect(summaries(h.events)[1]).toMatchObject({ polled: 0, failed: 0 })
  })

  it('单会话失败不中断整轮（其他会话照常）', async () => {
    const h = harness({
      conversations: [conversation({ convId: 'G-BAD' }), conversation({ convId: 'G-OK', pk: 2 })],
      pull: async (conv) => {
        if (conv.convId === 'G-BAD') throw new Error('坏会话')
        return { messages: [message({ convId: conv.convId })], cursor: 'c', hasMore: false }
      },
    })
    await h.poller.pullNow()
    expect(summaries(h.events)[0]).toMatchObject({ conversations: 2, polled: 2, failed: 1, inserted: 1 })
    expect(h.poller.conversationState('G-BAD').state).toBe('backoff')
    expect(h.poller.conversationState('G-OK').state).toBe('ok')
  })

  it('成功后清零退避与失败计数', async () => {
    let failNext = 1
    const h = harness({
      pull: async (conv) => {
        if (failNext > 0) {
          failNext -= 1
          throw new Error('偶发失败')
        }
        return { messages: [message({ convId: conv.convId })], cursor: 'c', hasMore: false }
      },
    })
    await h.poller.pullNow()
    expect(h.poller.conversationState('G-1001').failCount).toBe(1)
    // 推进业务时钟越过退避期，重试才会真正被放行
    h.clockAdvance(5000)
    await h.poller.pullNow()
    const state = h.poller.conversationState('G-1001')
    expect(state).toMatchObject({ state: 'ok', failCount: 0, backoffSec: 0 })
  })

  it('退避状态事件带原因（UI tooltip 展示）', async () => {
    const h = harness({
      pull: async () => {
        throw new Error('welink-cli 未找到')
      },
    })
    await h.poller.pullNow()
    expect(convStates(h.events)[0]).toMatchObject({ state: 'backoff', reason: 'welink-cli 未找到' })
  })

  it('有会话在退避时整轮间隔被拉长到最大退避（避免空转）', async () => {
    const h = harness({
      pull: async (_conv, _after, _limit) => {
        throw new Error('坏')
      },
    })
    h.poller.start()
    await settle()
    // 首轮失败 → 退避 5s，基准间隔也是 5s
    h.scheduler.advance(5000)
    await settle()
    // 第二轮失败 → 退避 10s > 基准 5s，下一轮应排到 10s 后
    expect(h.scheduler.nextAt()).toBe(10_000)
  })
})

// ---------------------------------------------------------------- 分级轮询 O2

describe('orchestrator/poller —— 分级轮询（O2）', () => {
const nowMs = parseStamp('2026-09-27 14:00:00')!.getTime()
/**
 * 「距今 ms 毫秒前」的本地时间戳。
 *
 * 必须用项目自己的 `nowStamp`（本地时间）而不是 `toISOString()`（**UTC**）——
 * 这正是 `utils/time.ts` 开头警告过的坑：东八区下 `toISOString()` 会差 8 小时，
 * 于是「29 分钟前」会被算成 8.5 小时前，分级轮询的断言全部失真（本文件踩过）。
 */
const ago = (ms: number) => nowStamp(new Date(nowMs - ms))

  it('从未有消息的会话视为热（首次导入必须立刻拉到数据）', async () => {
    const h = harness({ conversations: [conversation({ lastActive: '' })] })
    await h.poller.pullNow()
    expect(h.pullMock).toHaveBeenCalledTimes(1)
  })

  it('热会话（30min 内）每轮都拉', async () => {
    const h = harness({ conversations: [conversation({ lastActive: ago(HOT_WINDOW_MS - 60_000) })] })
    h.poller.start()
    await settle()
    await autoRounds(h, 2)
    // 首轮 + 2 轮 = 3 次，热会话每轮都拉
    expect(h.pullMock).toHaveBeenCalledTimes(3)
  })

  it(`温会话每 ${WARM_EVERY} 轮拉一次`, async () => {
    const h = harness({ conversations: [conversation({ lastActive: ago(HOT_WINDOW_MS + 60_000) })] })
    h.poller.start()
    await settle()
    await autoRounds(h, WARM_EVERY + 1)
    // roundNo % WARM_EVERY === 1 → 第 1/4 轮拉，第 2/3 轮跳过
    const polled = summaries(h.events).map((item) => item.polled)
    expect(polled[0]).toBe(1)
    expect(polled[1]).toBe(0)
    expect(polled[WARM_EVERY]).toBe(1)
  })

  it(`冷会话每 ${COLD_EVERY} 轮拉一次`, async () => {
    const h = harness({ conversations: [conversation({ lastActive: ago(48 * 60 * 60 * 1000) })] })
    h.poller.start()
    await settle()
    await autoRounds(h, 2)
    const polled = summaries(h.events).map((item) => item.polled)
    expect(polled[0]).toBe(1)
    expect(polled[1]).toBe(0)
  })

  it('手动拉取（manual=true）绕过分级判定', async () => {
    const h = harness({ conversations: [conversation({ lastActive: ago(48 * 60 * 60 * 1000) })] })
    h.poller.start()
    await settle()
    await autoRounds(h, 1) // 自动第 2 轮 → 冷会话被跳过
    expect(summaries(h.events)[1].polled).toBe(0)
    await h.poller.pullNow() // 手动 → 绕过
    expect(summaries(h.events).at(-1)!.polled).toBe(1)
  })

  it('本会话拉到新数据后立刻变热（后续轮次不再被跳过）', async () => {
    const h = harness({
      conversations: [conversation({ lastActive: ago(48 * 60 * 60 * 1000) })],
      pull: async (conv) => ({ messages: [message({ convId: conv.convId })], cursor: 'c', hasMore: false }),
      // 关掉拷贝 → 模拟「仓储每轮重新读库，能读到 poller 回写的 last_active」
      cloneConversations: false,
    })
    h.poller.start()
    await settle()
    // 第 1 轮：冷会话恰好轮到（roundNo=1 → 1 % 6 === 1）→ 拉到新消息 → 回写 lastActive
    expect(summaries(h.events)[0].polled).toBe(1)
    await autoRounds(h, 1)
    // 第 2 轮：本该因「冷」被跳过，但因上一轮回写了 lastActive，现在是热会话
    expect(summaries(h.events)[1].polled).toBe(1)
  })

  it('会话间错峰：第 2 个会话起等待 staggerMs', async () => {
    const h = harness({
      conversations: [conversation({ convId: 'G-1' }), conversation({ convId: 'G-2', pk: 2 })],
      staggerMs: 2000,
    })
    const pending = h.poller.pullNow()
    await settle()
    // 第 1 个会话已拉，第 2 个在等错峰定时器
    expect(h.pullMock).toHaveBeenCalledTimes(1)
    expect(h.scheduler.queued).toBe(1)
    h.scheduler.advance(2000)
    await pending
    expect(h.pullMock).toHaveBeenCalledTimes(2)
  })

  it('staggerMs=0 时不排错峰定时器（测试友好）', async () => {
    const h = harness({
      conversations: [conversation({ convId: 'G-1' }), conversation({ convId: 'G-2', pk: 2 })],
      staggerMs: 0,
    })
    await h.poller.pullNow()
    expect(h.pullMock).toHaveBeenCalledTimes(2)
  })
})

// ---------------------------------------------------------------- 可见性 P9

describe('orchestrator/poller —— 窗口可见性（P9）', () => {
  it('隐藏时轮询间隔 ×3', async () => {
    const h = harness({ settings: { pollIntervalSec: 5 } })
    h.poller.start()
    await settle()
    // `nextAt()` 是**绝对**虚拟时刻（此刻 cur=0，所以 5000 恰好等于 5s 间隔）
    expect(h.scheduler.nextAt()).toBe(5000)
    h.poller.setVisible(false)
    await settle()
    // setVisible 会重排到 0ms（立刻），所以拉取本身仍会发生，只是间隔系数变了
    expect(h.scheduler.nextAt()).toBe(0)
    await autoRounds(h, 1)
    // 该轮完成后按「基准 5s × 隐藏系数 3」排下一轮
    expect(h.scheduler.nextAt()).toBe(20_000)
  })

  it('恢复显示立即重排，不等原定时的长间隔', async () => {
    const h = harness({ settings: { pollIntervalSec: 5 } })
    h.poller.start()
    await settle()
    h.poller.setVisible(false)
    await settle()
    // 隐藏本身就是「立即重排」（等 0ms），而不是把当前定时器就地改成 15s
    expect(h.scheduler.nextAt()).toBe(h.scheduler.now())
    await autoRounds(h, 1)
    // 该轮完成后才按「基准 5s × 隐藏系数 3」排下一轮
    expect(h.scheduler.nextAt()).toBe(20_000)

    h.poller.setVisible(true)
    await settle()
    // 关键：恢复显示立刻重排到当下，**不等**那个 20s 的旧定时器
    expect(h.scheduler.nextAt()).toBe(h.scheduler.now())
    await autoRounds(h, 1)
    // 下一轮回到正常系数（5s）
    expect(h.scheduler.nextAt()).toBe(15_000)
  })

  it('重复设置同一值不重排（避免无谓抖动）', async () => {
    const h = harness()
    h.poller.start()
    await settle()
    await h.poller.refreshConversations() // 排到 0ms
    expect(h.scheduler.nextAt()).toBe(0)
    h.poller.setVisible(true) // 值未变 → 不动
    expect(h.scheduler.nextAt()).toBe(0)
  })

  it('未运行时 setVisible 不做任何排程', () => {
    const h = harness()
    h.poller.setVisible(false)
    expect(h.scheduler.queued).toBe(0)
  })
})

// ---------------------------------------------------------------- 拉取与入库

describe('orchestrator/poller —— 单会话拉取与入库', () => {
  it('触发表由 buildTriggerMap 计算后传给仓储（规则不进数据层）', async () => {
    const h = harness({
      pull: async () => ({
        messages: [message({ msgUid: 'hit' }), message({ msgUid: 'miss', atMe: false, content: '收到' })],
        cursor: 'c1',
        hasMore: false,
      }),
    })
    await h.poller.pullNow()
    const [, messages, cursor, rules] = h.repo.applyPollResult.mock.calls[0]
    expect(cursor).toBe('c1')
    expect(rules.triggers).toEqual({ hit: 'group_at_me' })
    expect(messages).toHaveLength(2)
  })

  it('@所有人 不建任务（poller 与规则层口径一致）', async () => {
    const h = harness({
      pull: async () => ({
        messages: [message({ msgUid: 'all', content: '@所有人 例会照常', atMe: true })],
        cursor: 'c',
        hasMore: false,
      }),
    })
    await h.poller.pullNow()
    expect(h.repo.applyPollResult.mock.calls[0][3].triggers).toEqual({})
  })

  it('自发消息经 filterSelf 改向后不建任务（防自回复循环）', async () => {
    const h = harness({
      pull: async () => ({
        messages: [message({ msgUid: 'self', senderId: 'E-0001' })],
        cursor: 'c',
        hasMore: false,
      }),
    })
    await h.poller.pullNow()
    const [, messages, , rules] = h.repo.applyPollResult.mock.calls[0]
    expect(messages[0].direction).toBe('out')
    expect(rules.triggers).toEqual({})
  })

  it('sendMode 取自设置（决定新 job 是否自动外发）', async () => {
    const h = harness({ settings: { sendMode: 'manual' } })
    await h.poller.pullNow()
    expect(h.repo.applyPollResult.mock.calls[0][3].sendMode).toBe('manual')
  })

  it('hasMore=true 时同轮续批（≤CONTINUE_BATCHES 次）', async () => {
    let batch = 0
    const h = harness({
      pull: async () => {
        batch += 1
        return { messages: [message({ msgUid: `m-${batch}` })], cursor: `c-${batch}`, hasMore: batch < 10 }
      },
    })
    await h.poller.pullNow()
    // CONTINUE_BATCHES=3 → 最多 3 次 pull，剩余留待下轮
    expect(h.pullMock).toHaveBeenCalledTimes(3)
    // P8：跨续批消息合并成**一次** applyPollResult（一个事务），游标取最后一批
    expect(h.repo.applyPollResult).toHaveBeenCalledTimes(1)
    expect(h.repo.applyPollResult.mock.calls[0][2]).toBe('c-3')
    // 三批消息都在同一次提交里（批内去重后按序）
    const submitted = h.repo.applyPollResult.mock.calls[0][1] as Array<{ msgUid: string }>
    expect(submitted.map((item) => item.msgUid)).toEqual(['m-1', 'm-2', 'm-3'])
  })

  it('hasMore=false 时立刻停止续批', async () => {
    let batch = 0
    const h = harness({
      pull: async () => {
        batch += 1
        return { messages: [message({ msgUid: `m-${batch}` })], cursor: `c-${batch}`, hasMore: false }
      },
    })
    await h.poller.pullNow()
    expect(h.pullMock).toHaveBeenCalledTimes(1)
  })

  it('空批次不调仓储（省一次事务）', async () => {
    const h = harness({ pull: async () => ({ messages: [], cursor: 'c', hasMore: false }) })
    await h.poller.pullNow()
    expect(h.repo.applyPollResult).not.toHaveBeenCalled()
    expect(summaries(h.events)[0]).toMatchObject({ inserted: 0, jobs: 0 })
  })

  it('新消息与新建任务分别发出 messagesAppended / jobCreated 事件（P5 增量）', async () => {
    const h = harness()
    h.repo.applyPollResult.mockResolvedValueOnce({
      inserted: [{ ...message(), pk: 9, convPk: 1, readFlag: false }],
      createdJobs: [{ pk: 3 }],
      cursor: 'c',
    })
    await h.poller.pullNow()
    expect(h.events.some((event) => event.type === 'messagesAppended')).toBe(true)
    expect(h.events.some((event) => event.type === 'jobCreated')).toBe(true)
  })

  it('拉取用会话自身的 lastCursor 作为起点（增量而非全量）', async () => {
    const h = harness({ conversations: [conversation({ lastCursor: 'cursor-from-db' })] })
    await h.poller.pullNow()
    expect(h.pullMock.mock.calls[0][1]).toBe('cursor-from-db')
  })

  it('pullBatchLimit 从设置读取（P8 载荷可控）', async () => {
    const h = harness({ settings: { pullBatchLimit: 42 } })
    await h.poller.pullNow()
    expect(h.pullMock.mock.calls[0][2]).toBe(42)
  })

  it('读取监控清单失败时发出 roundFinished 并安全返回（不抛）', async () => {
    const h = harness()
    h.repo.listWatching.mockRejectedValueOnce(new Error('库挂了'))
    const summary = await h.poller.pullNow()
    expect(summary).toMatchObject({ conversations: 0, polled: 0 })
    expect(h.events.some((event) => event.type === 'roundFinished')).toBe(true)
  })

  it('无监控会话时安全跑完（空轮）', async () => {
    const h = harness({ conversations: [] })
    expect(await h.poller.pullNow()).toMatchObject({ conversations: 0, polled: 0 })
  })
})

// ---------------------------------------------------------------- 清单热更新

describe('orchestrator/poller —— 监控清单热更新', () => {
  it('refreshConversations 发出 conversationsChanged 事件', async () => {
    const h = harness({ conversations: [conversation({ convId: 'G-1' }), conversation({ convId: 'G-2', pk: 2 })] })
    await h.poller.refreshConversations()
    const event = h.events.find((item) => item.type === 'conversationsChanged') as { convIds: string[] }
    expect(event.convIds).toEqual(['G-1', 'G-2'])
  })

  it('已删除会话的退避状态被清理（状态表不无限增长）', async () => {
    const h = harness({ conversations: [conversation({ convId: 'G-1' })] })
    await h.poller.pullNow()
    expect(h.poller.conversationState('G-1').state).toBe('ok')
    // 清单里不再有 G-1
    h.repo.listWatching.mockResolvedValueOnce([conversation({ convId: 'G-2', pk: 2 })])
    await h.poller.refreshConversations()
    // 状态被删 → 重新读取时是全新默认值
    expect(h.poller.conversationState('G-1')).toMatchObject({ state: 'ok', failCount: 0, lastOkAt: '' })
  })

  it('新增会话时重排下一轮为「立刻」（不等长间隔）', async () => {
    const h = harness()
    h.poller.start()
    await settle()
    expect(h.scheduler.nextAt()).toBe(5000)
    await h.poller.refreshConversations()
    expect(h.scheduler.nextAt()).toBe(0)
  })

  it('未运行时 refreshConversations 不排程', async () => {
    const h = harness()
    await h.poller.refreshConversations()
    expect(h.scheduler.queued).toBe(0)
  })

  it('轮询进行中时不抢排队（让当前轮自然结束再排）', async () => {
    const h = harness()
    h.poller.start()
    // 首轮仍在飞时 refresh
    await h.poller.refreshConversations()
    await settle()
    expect(h.repo.listWatching.mock.calls.length).toBeGreaterThanOrEqual(1)
  })

  it('读取清单失败时记录错误但不抛（热更新不该打断运行）', async () => {
    const h = harness()
    h.repo.listWatching.mockRejectedValue(new Error('库挂了'))
    await expect(h.poller.refreshConversations()).resolves.toBeUndefined()
  })
})

// ---------------------------------------------------------------- 会话状态查询

describe('orchestrator/poller —— conversationState 查询', () => {
  it('未知会话返回默认健康状态（不是 undefined）', () => {
    const h = harness()
    expect(h.poller.conversationState('NEVER-SEEN')).toEqual({
      state: 'ok',
      failCount: 0,
      backoffSec: 0,
      reason: '',
      lastOkAt: '',
    })
  })

  it('成功拉取后记录 lastOkAt（UI 显示「最近同步」）', async () => {
    const h = harness()
    await h.poller.pullNow()
    expect(h.poller.conversationState('G-1001').lastOkAt).toMatch(/^2026-09-27/)
  })

  it('返回的是副本（调用方改动不影响内部状态）', async () => {
    const h = harness()
    await h.poller.pullNow()
    const snapshot = h.poller.conversationState('G-1001')
    snapshot.failCount = 999
    expect(h.poller.conversationState('G-1001').failCount).toBe(0)
  })

  it('初始 round() 为 0，跑过之后递增', async () => {
    const h = harness()
    expect(h.poller.round()).toBe(0)
    await h.poller.pullNow()
    expect(h.poller.round()).toBe(1)
  })
})

// ---------------------------------------------------------------- 导出常量

describe('orchestrator/poller —— 导出常量（外部契约）', () => {
  it('BACKOFF_STEPS 是递增的 5 步序列', () => {
    expect(BACKOFF_STEPS).toEqual([5, 10, 20, 40, 60])
  })

  it('分级阈值与轮次常量符合设计值', () => {
    expect(HOT_WINDOW_MS).toBe(30 * 60 * 1000)
    expect(WARM_EVERY).toBe(3)
    expect(COLD_EVERY).toBe(6)
  })
})