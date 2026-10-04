/**
 * 消息端口 Mock（设计 §3.3 / v4.4-O13 剧本引擎）。
 *
 * [MOCK-CLI] 本文件是 welink-cli 消息能力的**模拟替身**（真实 CLI 就绪前后都保留：
 * 单测替身 + 浏览器调试数据源 D5）。与真实行为的差异清单，对接时逐项核对：
 *  * 会话候选固定为 MOCK_CONVERSATIONS（5 条，convId/工号均虚构）；
 *  * pull 游标是 `mock:<convId>:<批次>` 格式 —— 真实游标语义由 CLI 决定（对业务不透明）；
 *  * send 回执 msgUid 是 `mock-out-<convId>-<序号>` 本地编号 —— 真实回执以 CLI 返回为准；
 *  * 时间用逻辑时钟推进（advance），非真实时钟；
 *  * 演示剧本（DEMO_SCRIPT）与确定性故障注入是测试/演示专用通道，真实 CLI 无此概念。
 *
 * 本期交付的核心目的：**在真实 welink-cli 未就绪时，把整条链路跑通并可演示**。
 * 因此这里的 mock 不是「返回几条死数据」，而是：
 *
 *  * 脚本化消息流：按会话维护游标，每次 `pull` 推进一批，含 @我 / 私聊 / 自发 /
 *    非文本占位样本（第 2 批起图片）；
 *  * 可注入延迟与确定性故障（`failures` 计数、固定种子）—— 测试依赖确定性，
 *    随机故障会让 CI 随机变红；
 *  * 「演示剧本」（O13）：预置「新人群@我 → 私聊追问 → 对方回应」三段，
 *    评审/培训时一键回放。
 *
 * 与真实实现共享同一套端口夹具测试（设计 §3.3），所以这里的行为偏差会被回归抓到。
 */
import type { NormalizedMessage, WelinkConversation, WelinkConvType } from '@/types/welink'
import { nowStamp } from '@/utils/time'
import { WelinkError, type PullResult, type WelinkPort } from './port'

/** mock 会话候选（`listConversations` 的返回，也是剧本的舞台） */
export const MOCK_CONVERSATIONS: WelinkConversation[] = [
  {
    pk: 1,
    convType: 'group',
    convId: 'G-1001',
    title: '研发一组',
    remark: '',
    watching: false,
    autoReply: false,
    muteUntil: null,
    lastMsgAt: '',
    unreadCount: 0,
    mentionCount: 0,
    lastActive: '',
    lastCursor: '',
    updatedAt: '',
  },
  {
    pk: 2,
    convType: 'group',
    convId: 'G-1002',
    title: '产品需求群',
    remark: '',
    watching: false,
    autoReply: false,
    muteUntil: null,
    lastMsgAt: '',
    unreadCount: 0,
    mentionCount: 0,
    lastActive: '',
    lastCursor: '',
    updatedAt: '',
  },
  {
    pk: 3,
    convType: 'group',
    convId: 'G-1003',
    title: '客户对接群',
    remark: '',
    watching: false,
    autoReply: false,
    muteUntil: null,
    lastMsgAt: '',
    unreadCount: 0,
    mentionCount: 0,
    lastActive: '',
    lastCursor: '',
    updatedAt: '',
  },
  {
    pk: 4,
    convType: 'private',
    convId: 'E-2001',
    title: '李明',
    remark: '',
    watching: false,
    autoReply: false,
    muteUntil: null,
    lastMsgAt: '',
    unreadCount: 0,
    mentionCount: 0,
    lastActive: '',
    lastCursor: '',
    updatedAt: '',
  },
  {
    pk: 5,
    convType: 'private',
    convId: 'E-2002',
    title: '王晓',
    remark: '',
    watching: false,
    autoReply: false,
    muteUntil: null,
    lastMsgAt: '',
    unreadCount: 0,
    mentionCount: 0,
    lastActive: '',
    lastCursor: '',
    updatedAt: '',
  },
]

/** 剧本片段：一次 pull 返回一批（同批内时间递增，跨批严格递增） */
interface ScriptStep {
  /** 该批针对的会话；null = 任意会话（按请求的会话生成） */
  convId: string | null
  messages: Array<{
    /** 相对上一批的偏移秒数 */
    offsetSec: number
    senderId: string
    senderName: string
    content: string
    atMe?: boolean
    direction?: 'in' | 'out'
    msgType?: string
  }>
}

/**
 * 剧本引擎（O13）：预置「新人群聊@我 → 私聊追问 → 对方回应」。
 *
 * 回放方式：`playScript('demo')` 把当前会话的脚本指针重置到开头，
 * 之后每次 `pull` 消费一个片段。这样「回放」与「轮询」是同一个机制，
 * 演示时不需要额外的注入通道。
 */
export const DEMO_SCRIPT: Record<string, ScriptStep[]> = {
  demo: [
    {
      convId: null,
      messages: [
        { offsetSec: 0, senderId: 'E-9001', senderName: '赵敏', content: '@所有人 下午三点例会照常' },
        { offsetSec: 6, senderId: 'E-9002', senderName: '孙倩', content: '收到' },
        {
          offsetSec: 12,
          senderId: 'E-2001',
          senderName: '李明',
          content: '@你 你好，客户反馈登录页报 500，麻烦看下日志',
          atMe: true,
        },
      ],
    },
    {
      convId: null,
      messages: [
        // 私聊追问段带一条图片（占位存档、不触发回复）—— 演示「非文本只入档」的分流
        { offsetSec: 2, senderId: 'E-2001', senderName: '李明', content: '[图片]', msgType: 'image' },
        { offsetSec: 4, senderId: 'E-2001', senderName: '李明', content: '补充一下：只有生产环境复现，测试环境正常' },
      ],
    },
    {
      convId: null,
      messages: [{ offsetSec: 5, senderId: 'E-2001', senderName: '李明', content: '好的，麻烦尽快，我这边等消息' }],
    },
    {
      // 技能路由演示段（skill-routing O13 扩展）：与首段不同的问题类型 ——
      // 配置「进度查询」技能（关键词如 进度/到哪一步）后，可观察到同一演示里
      // 路由到不同技能，且「Agent 回溯」能看到分类调用与生成调用两条留痕
      convId: null,
      messages: [
        { offsetSec: 3, senderId: 'E-2001', senderName: '李明', content: '另外问下，昨天提的发布审批现在到哪一步了？' },
      ],
    },
    {
      convId: null,
      messages: [
        { offsetSec: 3, senderId: 'E-9003', senderName: '周涛', content: '@你 麻烦把最新的接口文档发我一份，谢谢', atMe: true },
      ],
    },
  ],
}

export interface MockWelinkOptions {
  /** 每个会话的基准批大小（pull 的 limit 仍生效，取两者较小值） */
  batchSize?: number
  /** 每批的模拟网络延迟（毫秒），用于演示「UI 不卡」 */
  latencyMs?: number
  /** 确定性故障注入：前 N 次 pull 抛 transport 错（测试退避策略用） */
  pullFailures?: number
  /** 发送失败注入：前 N 次 send 抛错（测试外发重试与防双发） */
  sendFailures?: number
}

interface MockState {
  /** 每会话已发出的批次数（作为游标推进依据） */
  batches: Map<string, number>
  /** 最后一次消息时间，保证跨批时间严格递增 */
  clock: string
  pullCount: number
  sendCount: number
  /** 剧本模式下每会话的片段指针 */
  scriptCursor: Map<string, number>
  /** 已发送消息（回执核对用） */
  sent: Array<{ convId: string; text: string; msgUid: string; at: string }>
}

function createState(): MockState {
  return { batches: new Map(), clock: nowStamp(), pullCount: 0, sendCount: 0, scriptCursor: new Map(), sent: [] }
}

/** 把时间戳往后推 n 秒（mock 时间推进：真实 CLI 用真实时间，mock 用逻辑时钟便于断言） */
function advance(stamp: string, seconds: number): string {
  const parsed = new Date(stamp.replace(' ', 'T'))
  parsed.setSeconds(parsed.getSeconds() + seconds)
  return nowStamp(parsed)
}

export interface MockWelinkPort extends WelinkPort {
  /** 当前状态快照（测试断言用） */
  readonly state: MockState
  /** 重置全部 mock 状态（测试隔离） */
  reset(): void
  /** 回放演示剧本（O13）：把指定会话的脚本指针拨回开头 */
  playScript(name?: string): void
  /** 注入一次确定性 pull 故障 */
  failNextPull(times?: number): void
  /** 已发送记录（断言「发了几条、内容是什么」） */
  readonly sentMessages: MockState['sent']
}

export function createMockWelinkPort(options: MockWelinkOptions = {}): MockWelinkPort {
  const batchSize = options.batchSize ?? 3
  const latencyMs = options.latencyMs ?? 0
  let pullFailures = options.pullFailures ?? 0
  let sendFailures = options.sendFailures ?? 0
  const state = createState()

  const sleep = (ms: number) => (ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve())

  /**
   * 常规（非剧本）消息池：按会话类型给不同内容，保证 @我/私聊/自发都有样本；
   * 第 2 批起第 2 条轮换为图片样本 —— 非文本「占位存档」链路（R2 / 设计 §7.1）
   * 在演示模式下可见（真实 welink-cli 的会话流必然含图片/文件，纯文本池是失真的）。
   */
  function ambientBatch(conv: WelinkConversation, index: number): NormalizedMessage[] {
    const seq = index + 1
    const base: Array<Omit<NormalizedMessage, 'msgUid' | 'convId' | 'convType' | 'sentAt'>> = [
      {
        direction: 'in',
        senderId: conv.convType === 'group' ? 'E-9002' : conv.convId,
        senderName: conv.convType === 'group' ? '孙倩' : conv.title,
        content:
          conv.convType === 'group'
            ? `@你 第 ${seq} 条：接口文档更新了，帮忙确认下`
            : `第 ${seq} 条：方便同步一下进度吗？`,
        msgType: 'text',
        atMe: conv.convType === 'group',
      },
      {
        direction: 'in',
        senderId: 'E-9003',
        senderName: '周琳',
        content: `第 ${seq} 条：这个需求我这边可以先评估`,
        msgType: 'text',
        atMe: false,
      },
      {
        direction: 'out',
        senderId: '',
        senderName: '',
        content: `第 ${seq} 条：好的，我看看`,
        msgType: 'text',
        atMe: false,
      },
    ]
    if (index > 0) {
      base[1] = {
        direction: 'in',
        senderId: 'E-9003',
        senderName: '周琳',
        content: '[图片]',
        msgType: 'image',
        atMe: false,
      }
    }
    return base.slice(0, Math.max(1, Math.min(batchSize, 3))).map((item, itemIndex) => ({
      ...item,
      msgUid: `${conv.convId}-${seq}-${itemIndex}`,
      convId: conv.convId,
      convType: conv.convType,
      sentAt: advance(state.clock, itemIndex + 1),
    }))
  }

  /** 剧本批次：按指针消费 `DEMO_SCRIPT`，指针越界后不再产出（剧本放完即静默） */
  function scriptBatch(conv: WelinkConversation): NormalizedMessage[] {
    const steps = DEMO_SCRIPT.demo
    const pointer = state.scriptCursor.get(conv.convId) ?? 0
    if (pointer >= steps.length) return []
    const step = steps[pointer]
    state.scriptCursor.set(conv.convId, pointer + 1)
    return step.messages.map((item, itemIndex) => ({
      msgUid: `${conv.convId}-demo-${pointer}-${itemIndex}`,
      convId: conv.convId,
      convType: conv.convType,
      direction: item.direction ?? 'in',
      senderId: item.senderId,
      senderName: item.senderName,
      content: item.content,
      msgType: item.msgType ?? 'text',
      atMe: item.atMe ?? false,
      sentAt: advance(state.clock, item.offsetSec + itemIndex),
    }))
  }

  return {
    state,
    get sentMessages() {
      return state.sent
    },

    reset() {
      const fresh = createState()
      state.batches = fresh.batches
      state.clock = fresh.clock
      state.pullCount = 0
      state.sendCount = 0
      state.scriptCursor = fresh.scriptCursor
      state.sent.length = 0
    },

    playScript() {
      // 回放 = 把脚本指针拨回开头；同时把逻辑时钟留到今天，避免消息时间落在过去
      for (const conv of MOCK_CONVERSATIONS) state.scriptCursor.set(conv.convId, 0)
      state.clock = nowStamp()
    },

    failNextPull(times = 1) {
      pullFailures = times
    },

    async listConversations() {
      // [MOCK-CLI] 固定候选清单（真实侧来自 welink-cli list --json）
      await sleep(latencyMs)
      return MOCK_CONVERSATIONS.map((conv) => ({ ...conv }))
    },

    async pull(conv, after, limit): Promise<PullResult> {
      // [MOCK-CLI] 按剧本/消息池推进批次；`after` 不参与语义（游标 mock: 前缀，仅回传）
      await sleep(latencyMs)
      state.pullCount += 1
      if (pullFailures > 0) {
        pullFailures -= 1
        throw new WelinkError('mock：模拟传输故障', 'transport')
      }

      const scripted = state.scriptCursor.has(conv.convId)
      const index = state.batches.get(conv.convId) ?? 0
      const batch = scripted ? scriptBatch(conv) : ambientBatch(conv, index)
      state.batches.set(conv.convId, index + 1)

      const limited = batch.slice(0, Math.max(1, Math.min(limit, batch.length || 1)))
      const cursor = `mock:${conv.convId}:${state.batches.get(conv.convId)}`
      // hasMore 只在「本批被 limit 截断」时为真 —— 让编排层的续批逻辑有真实触发条件
      const hasMore = batch.length > limited.length
      void after
      return { messages: limited, cursor, hasMore }
    },

    async send(target: { convId: string; convType: WelinkConvType }, text: string) {
      // [MOCK-CLI] 记账即成功，回执 ID 本地编号（真实侧以 CLI 返回的 msgUid 为准）
      await sleep(latencyMs)
      state.sendCount += 1
      if (sendFailures > 0) {
        sendFailures -= 1
        throw new WelinkError('mock：模拟发送失败', 'transport')
      }
      state.clock = advance(state.clock, 1)
      const msgUid = `mock-out-${target.convId}-${state.sendCount}`
      state.sent.push({ convId: target.convId, text, msgUid, at: state.clock })
      return { msgUid }
    },
  }
}
