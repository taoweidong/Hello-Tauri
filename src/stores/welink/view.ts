/**
 * 会话视图与会话配置（quality-hardening-2026-10 D1）—— 装载 / 选择 / 翻页 /
 * 监控配置的本地视图逻辑。竞态守卫（F-4 代次号）与 in-flight 锁都在这层，
 * 它们保护的是视图状态的一致性，不属于编排层。
 */
import type { Ref, ShallowRef } from 'vue'

import { nowStamp } from '@/utils/time'
import { logger } from '@/utils/logger'
import type { WelinkRuntime } from '@/orchestrator/runtime'
import type { ConversationState } from '@/orchestrator/events'
import type { WelinkRepository } from '@/infra/db'
import { CONVERSATION_PAGE_LIMIT, type WelinkConversation, type WelinkJob, type WelinkMessage } from '@/types/welink'

export interface ConversationViewDeps {
  conversations: Ref<WelinkConversation[]>
  conversationsLoaded: Ref<boolean>
  convoStates: Ref<Record<string, ConversationState>>
  messages: Ref<WelinkMessage[]>
  convJobs: Ref<WelinkJob[]>
  jobIndex: ShallowRef<Map<number, WelinkJob>>
  hasMoreMessages: Ref<boolean>
  selectedConvId: Ref<string>
  reviewCount: Ref<number>
  /** 编排层运行时持有者（延迟装配，可能为 null —— 视图必须容忍未启动态） */
  runtimeHolder: { current: WelinkRuntime | null }
  /** 存储网关注入点（orchestrator/welink-storage） */
  repo: () => WelinkRepository
  ensureRuntime: () => Promise<WelinkRuntime>
  pushLog: (level: 'info' | 'warn' | 'error', text: string) => void
  /** 安全快照刷新（index 持有的共享函数：updateConversation 联动熔断横幅） */
  refreshSafety: () => Promise<void>
}

export interface ConversationView {
  loadConversations(): Promise<void>
  fetchConversations(limit?: number): Promise<WelinkConversation[]>
  countMessagesOf(convId: string): Promise<number>
  refreshReviewCount(): Promise<void>
  selectConversation(convId: string, limit?: number): Promise<void>
  loadEarlierMessages(limit?: number): Promise<void>
  previewSync(): Promise<{
    fresh: Array<{ convType: WelinkConversation['convType']; convId: string; title: string }>
    known: number
    total: number
  }>
  syncConversations(watchIds?: string[]): Promise<{ imported: number; watched: number; skipped: number }>
  upsertConversation(input: {
    convType: WelinkConversation['convType']
    convId: string
    title?: string
    remark?: string
    watching?: boolean
  }): Promise<void>
  updateConversation(
    convId: string,
    patch: Partial<Pick<WelinkConversation, 'title' | 'remark' | 'watching' | 'autoReply' | 'muteUntil'>>,
  ): Promise<void>
  setAutoReply(convIds: string[], enabled: boolean): Promise<number>
  muteConversation(convId: string, hours: number): Promise<void>
  removeConversation(convId: string): Promise<void>
}

export function createConversationView(deps: ConversationViewDeps): ConversationView {
  const {
    conversations,
    conversationsLoaded,
    convoStates,
    messages,
    convJobs,
    jobIndex,
    hasMoreMessages,
    selectedConvId,
    reviewCount,
    runtimeHolder,
    repo,
    ensureRuntime,
    pushLog,
    refreshSafety,
  } = deps

  async function loadConversations() {
    conversations.value = await repo().listConversations(CONVERSATION_PAGE_LIMIT, 0)
    conversationsLoaded.value = true
    // 超限不能静默（D-5）：总表计数与返回条数一比，超限就明确告警（仍不自动
    // 翻页：会话列表是人工维护的白名单，量级到上限时更该让用户看见）。
    if (conversations.value.length >= CONVERSATION_PAGE_LIMIT) {
      const total = await repo().countConversations()
      if (total > conversations.value.length) {
        logger.warn(
          `WeLink：会话列表已达上限（显示 ${conversations.value.length} / 共 ${total} 个），` +
            `超出部分未展示 —— 建议清理不再需要的会话`,
        )
      }
    }
    const runtime = runtimeHolder.current
    if (runtime) {
      const next: Record<string, ConversationState> = { ...convoStates.value }
      for (const conv of conversations.value) next[conv.convId] = runtime.poller.conversationState(conv.convId)
      convoStates.value = next
      /**
       * 顺手回填 Gate 的会话开关缓存（O5），并接上熔断预留位。
       *
       * 放在这里而不是各 mutation 里逐个 writethrough：**所有**会话变更
       * （upsert / update / 批量开关 / 静音 / 同步导入）都已经以
       * `loadConversations()` 收尾，只有这一处能保证「缓存与库一致」不会漏。
       */
      for (const conv of conversations.value) {
        runtime.gate.cacheConversation(conv.convId, conv.autoReply, conv.muteUntil)
      }
    }
  }

  /**
   * 只读拉取会话列表（监控配置页用）。
   *
   * 为什么不让它直接写 `conversations`：配置页的筛选/分页是**本地视图**，
   * 若共用共享 state，配置页翻页会把消息中心左栏的列表一起换掉。
   */
  async function fetchConversations(limit = 500) {
    return repo().listConversations(limit, 0)
  }

  /** 该会话的存档消息数（删除会话的二次确认要如实告知影响范围） */
  async function countMessagesOf(convId: string): Promise<number> {
    const conv = conversations.value.find((item) => item.convId === convId) ?? (await repo().getConversation(convId))
    if (!conv) return 0
    return repo().countMessages(conv.pk)
  }

  async function refreshReviewCount() {
    reviewCount.value = await repo().countHolding()
    // 待审任务需要在索引里可用（表格与右栏展示）—— 只取第一页，避免一次拉全量
    const holding = await repo().listJobs({ onlyHolding: true, limit: 100, offset: 0 })
    for (const job of holding) jobIndex.value.set(job.pk, job)
    jobIndex.value = new Map(jobIndex.value)
  }

  // ---------------- 会话选择与时间线（消息中心 / 收件箱共用） ----------------

  /** 加载代次号（评审 F-4 竞态守卫）：selectConversation 每次进入递增 */
  let timelineSeq = 0

  /** 选中会话：清未读 + 拉时间线 + 取该会话待办（§6.4 markRead O6） */
  async function selectConversation(convId: string, limit = 100) {
    selectedConvId.value = convId
    // 时间线加载竞态守卫（评审 F-4）：快速连点会话 A→B 时，A 的后返回会把
    // messages/convJobs 覆盖成 A 的内容（selectedConvId 已是 B）——每次加载
    // 取一个代次号，await 后代次不符即丢弃本次结果。
    const seq = ++timelineSeq
    const conv = conversations.value.find((item) => item.convId === convId)
    if (!conv) return
    await repo().markRead(conv.pk)
    if (seq !== timelineSeq) return
    conv.unreadCount = 0
    conv.mentionCount = 0
    conversations.value = [...conversations.value]
    const page = await repo().listMessages({ convPk: conv.pk, limit })
    if (seq !== timelineSeq) return
    messages.value = page
    hasMoreMessages.value = page.length >= limit
    const jobs = (await repo().listJobsByStatus(['pending', 'discussing', 'ready', 'sending', 'failed'], 200)).filter(
      (job) => job.targetId === convId,
    )
    if (seq !== timelineSeq) return
    convJobs.value = jobs
    for (const job of convJobs.value) jobIndex.value.set(job.pk, job)
    jobIndex.value = new Map(jobIndex.value)
  }

  /** 向上翻页（P7：一次 100 条）。in-flight 锁防连点：重复请求同一 before 会把
   * 同一批消息拼两次，msg_uid 作 v-for key 时直接渲染重复行（评审 F-4）。 */
  let loadingEarlier = false
  async function loadEarlierMessages(limit = 100) {
    if (loadingEarlier) return
    loadingEarlier = true
    try {
      const seq = timelineSeq
      const conv = conversations.value.find((item) => item.convId === selectedConvId.value)
      if (!conv || !messages.value.length) return
      const before = messages.value[0].sentAt
      const older = await repo().listMessages({ convPk: conv.pk, before, limit })
      if (seq !== timelineSeq) return
      if (older.length) {
        messages.value = [...older, ...messages.value]
        hasMoreMessages.value = older.length >= limit
      } else {
        hasMoreMessages.value = false
      }
    } finally {
      loadingEarlier = false
    }
  }

  // ---------------- 会话配置（R1 / O11 / §11.5 同步） ----------------

  /**
   * 同步预览（§11.5）：只拉候选并分类，**不落库**。
   *
   * 为什么要把「拉候选」与「导入」拆开：设计要求的是一张 diff 对话框 ——
   * 用户先看清「新增哪些、已有多少」，再决定给哪些新会话直接勾上监控。
   * 一步到位的导入会让「同步」变成一个没有确认环节的写操作。
   */
  async function previewSync(): Promise<{
    fresh: Array<{ convType: WelinkConversation['convType']; convId: string; title: string }>
    known: number
    total: number
  }> {
    const active = await ensureRuntime()
    const candidates = await active.port().listConversations()
    const knownSet = new Set(conversations.value.map((item) => item.convId))
    const fresh = candidates
      .filter((candidate) => !knownSet.has(candidate.convId))
      .map((candidate) => ({ convType: candidate.convType, convId: candidate.convId, title: candidate.title }))
    return { fresh, known: candidates.length - fresh.length, total: candidates.length }
  }

  /**
   * 提交同步：`watchIds` 内的新会话导入时直接勾上监控（**仍不回复** —— §11.5 底线的
   * 「默认不监控、不回复」，勾 watch 只是省一次点击，autoReply 一律保持关）。
   * 已有项只更新 title，绝不覆盖 watching / autoReply / remark。
   */
  async function syncConversations(
    watchIds: string[] = [],
  ): Promise<{ imported: number; watched: number; skipped: number }> {
    const active = await ensureRuntime()
    // 候选清单来自端口（真实 CLI / mock），导入到库；已有项不覆盖 watching/auto_reply
    const candidates = await active.port().listConversations()
    const known = new Set(conversations.value.map((item) => item.convId))
    const watchSet = new Set(watchIds)
    let imported = 0
    let watched = 0
    for (const candidate of candidates) {
      const allowWatch = watchSet.has(candidate.convId) && !known.has(candidate.convId)
      await active.repo.upsertConversation({
        convType: candidate.convType,
        convId: candidate.convId,
        title: candidate.title,
        watching: allowWatch,
      })
      if (!known.has(candidate.convId)) imported += 1
      if (allowWatch) watched += 1
    }
    await loadConversations()
    runtimeHolder.current?.poller.refreshConversations()
    pushLog(
      'info',
      `同步会话完成：新增 ${imported} 个（默认不监控、不回复）${watched ? `，其中 ${watched} 个已勾选监控` : ''}`,
    )
    return { imported, watched, skipped: candidates.length - imported }
  }

  async function upsertConversation(input: {
    convType: WelinkConversation['convType']
    convId: string
    title?: string
    remark?: string
    watching?: boolean
  }) {
    await repo().upsertConversation(input)
    await loadConversations()
    runtimeHolder.current?.poller.refreshConversations()
  }

  async function updateConversation(
    convId: string,
    patch: Partial<Pick<WelinkConversation, 'title' | 'remark' | 'watching' | 'autoReply' | 'muteUntil'>>,
  ) {
    await repo().updateConversation(convId, patch)
    runtimeHolder.current?.gate.invalidateConversation(convId)
    // 关掉监控时联动关掉自动回复（watching=0 的会话不该继续外发）——§11.5 的约束
    if (patch.watching === false) {
      await repo().updateConversation(convId, { autoReply: false })
    }
    await loadConversations()
    runtimeHolder.current?.poller.refreshConversations()
    await refreshSafety()
  }

  async function setAutoReply(convIds: string[], enabled: boolean): Promise<number> {
    const changed = await repo().setAutoReply(convIds, enabled)
    for (const convId of convIds) runtimeHolder.current?.gate.invalidateConversation(convId)
    await loadConversations()
    await refreshSafety()
    return changed
  }

  /** O11 静音：1h / 8h / 今天 */
  async function muteConversation(convId: string, hours: number) {
    const until = new Date(Date.now() + hours * 3600 * 1000)
    await repo().updateConversation(convId, { muteUntil: nowStamp(until) })
    runtimeHolder.current?.gate.invalidateConversation(convId)
    await loadConversations()
    pushLog('info', `「${convId}」已静音 ${hours} 小时（到期自动恢复）`)
  }

  async function removeConversation(convId: string) {
    await repo().removeConversation(convId)
    if (selectedConvId.value === convId) {
      selectedConvId.value = ''
      messages.value = []
      convJobs.value = []
    }
    await loadConversations()
    runtimeHolder.current?.poller.refreshConversations()
  }

  return {
    loadConversations,
    fetchConversations,
    countMessagesOf,
    refreshReviewCount,
    selectConversation,
    loadEarlierMessages,
    previewSync,
    syncConversations,
    upsertConversation,
    updateConversation,
    setAutoReply,
    muteConversation,
    removeConversation,
  }
}
