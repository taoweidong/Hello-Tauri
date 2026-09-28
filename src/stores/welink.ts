/**
 * WeLink 助手 store（设计 §5-P5 / §6.4 / O7）—— 编排层与 UI 之间唯一的状态层。
 *
 * 三条职责边界：
 *  1. **不推全量列表**：只消费编排层的事件，增量打补丁（P5）。消息追加、任务状态
 *     变化都是「就地改一行」，UI 配合 keyed `v-for` 只挂载新增行，不整表重渲染。
 *  2. **聚合口径唯一**：`reviewCount`（O7 待审）、`safety`（熔断/配额）、
 *     `running`（控制条状态灯）都只在这里算一次，视图不做二次聚合 ——
 *     两处算同一个数就一定会出现两个数不一致。
 *  3. **动作即映射**（§6.4）：UI 的每个按钮对应这里一个方法，方法体是薄的一层
 *     转发 + 本地状态同步；真正的业务在编排层。
 */
import { defineStore } from 'pinia'
import { computed, ref, shallowRef } from 'vue'

import { platform } from '@/api'
import { dbMigrateAll, welink } from '@/infra/db'
import type { InboxQuery, JobQuery, WelinkRepository } from '@/infra/db'
import {
  DEFAULT_WELINK_SETTINGS,
  normalizeWelinkSettings,
  type HoldReason,
  type JobRating,
  type JobStatus,
  type WelinkAgentLog,
  type WelinkConversation,
  type WelinkJob,
  type WelinkMessage,
  type WelinkSettings,
} from '@/types/welink'
import { logger, onLog } from '@/utils/logger'
import { planPollRound, POLL_STAGGER_MS, type PollRoundPlan } from '@/utils/poll'
import { nowStamp, today } from '@/utils/time'
import type { ConversationState, PollSummary, SafetySnapshot, WelinkEvent } from '@/orchestrator/events'
import { emptySummary } from '@/orchestrator/events'
import { createWelinkRuntime, type WelinkRuntime } from '@/orchestrator/runtime'
import type { BootstrapReport } from '@/orchestrator/bootstrap'
import { CONVERSATION_PAGE_LIMIT, HOLD_REASON_LABEL, JOB_STATUS_LABEL, SKIP_REASON_LABEL } from '@/infra/db/ports'

/** 运行状态灯（§11.0） */
export type RuntimeStatus = 'idle' | 'init' | 'running' | 'backoff' | 'stopped' | 'panic'

/** 日志旁路只订阅一次（模块级，避免 store 重建时重复叠加订阅） */
let logUnsubscribe: (() => void) | null = null

/**
 * 退订日志旁路（D-9）。
 *
 * 为什么需要：模块级单例 + `if (!logUnsubscribe)` 守卫使得**重复订阅不会发生**，
 * 但「声明了退订函数却永不调用」是一句没兑现的承诺 —— 将来若把 store 改成
 * 非单例（如多实例/热重载场景），它会立刻变成一个真实的引用泄漏。
 *
 * 调用时机：页面卸载（`WeLinkView.onUnmounted`）与测试的 `afterEach`。
 * 注意退订后**不能**清 `logs`：日志是用户的诊断信息，卸载页面不该抹掉它。
 */
export function unsubscribeWelinkLogs(): void {
  logUnsubscribe?.()
  logUnsubscribe = null
}

export const useWelinkStore = defineStore('welink', () => {
  // ---------------- 配置 ----------------
  /**
   * 配置本体由 appStore 持有并持久化；这里保存「运行期归一化后的副本」，
   * 避免 store 之间循环依赖（appStore ← → welinkStore）。
   */
  const settings = ref<WelinkSettings>({ ...DEFAULT_WELINK_SETTINGS })

  // ---------------- 运行时 ----------------
  const status = ref<RuntimeStatus>('idle')
  const bootstrapReport = ref<BootstrapReport | null>(null)
  const pullSummary = ref<PollSummary>({ ...emptySummary() })
  const pulling = ref(false)
  const safety = ref<SafetySnapshot>({
    panic: false,
    globalCount: 0,
    globalCap: DEFAULT_WELINK_SETTINGS.safety.globalHourlyCap,
    globalClosedUntil: null,
    convCounts: {},
    fuses: [],
    globalFuse: false,
    globalFuseReason: '',
  })
  /** 熔断横幅（S8 触发时的黄条） */
  const fuseBanner = ref<{ scope: string; reason: string; blocked: number } | null>(null)
  /** 运行日志（内存环形缓冲，最多 200 行 —— P10：不落库不刷屏） */
  const logs = ref<Array<{ at: string; level: 'info' | 'warn' | 'error'; text: string }>>([])

  // ---------------- 数据视图（增量维护） ----------------
  const conversations = ref<WelinkConversation[]>([])
  /**
   * 会话清单是否已装载过。
   *
   * 为什么需要这个标志：`conversations` 初值是 `[]`，而「装载过但没有监控会话」
   * 与「压根没装载」在数据上完全同形。设置页的轮询周期提示必须区分这两者 ——
   * 否则用户从未打开助手页时，页面会振振有词地写「当前 0 个监控会话」，
   * 这是**错话**而不是空话（D-6 的提示若不可信，比不提示更坏）。
   */
  const conversationsLoaded = ref(false)
  const convoStates = ref<Record<string, ConversationState>>({})
  /** 当前选中会话的消息时间线（增量 append） */
  const messages = ref<WelinkMessage[]>([])
  const jobIndex = shallowRef<Map<number, WelinkJob>>(new Map())
  /** 消息中心右栏：该会话未终态任务 */
  const convJobs = ref<WelinkJob[]>([])
  const hasMoreMessages = ref(false)
  /** 待审数量（O7：hold_reason≠'' 的 ready job 数） */
  const reviewCount = ref(0)
  const selectedConvId = ref('')

  /** 编排层运行时（延迟创建：首次 start 时才装配，避免点开页面就建端口） */
  let runtime: WelinkRuntime | null = null

  // ---------------- 事件消费（P5） ----------------

  function onEvent(event: WelinkEvent) {
    switch (event.type) {
      case 'messagesAppended': {
        if (event.convId === selectedConvId.value) {
          // 去重：发送成功后管线会补一条 out 消息，可能与后续拉取到的同 uid 消息重复
          const known = new Set(messages.value.map((item) => item.msgUid))
          const fresh = event.messages.filter((item) => !known.has(item.msgUid))
          if (fresh.length) {
            messages.value = [...messages.value, ...fresh].sort((a, b) =>
              a.sentAt === b.sentAt ? a.pk - b.pk : a.sentAt < b.sentAt ? -1 : 1,
            )
          }
        }
        patchConversationFromMessages(event.convId, event.messages)
        break
      }
      case 'jobCreated': {
        patchJob(event.job)
        if (event.job.status === 'ready' && event.job.holdReason) reviewCount.value += 1
        if (event.job.targetId === selectedConvId.value) upsertConvJob(event.job)
        break
      }
      case 'jobStatusChanged': {
        const job = jobIndex.value.get(event.jobPk)
        if (job) {
          const wasHolding = job.status === 'ready' && Boolean(job.holdReason)
          job.status = event.to
          job.updatedAt = nowStamp()
          if (event.to === 'skipped') job.skipReason = String(event.reason)
          // 待审原因以事件为准（O7）：转审是 ready → ready 的同状态流转，
          // 只用 from/to 判断不出「刚被转人工」，必须看事件带出的 holdReason。
          if (event.holdReason !== undefined) job.holdReason = event.holdReason
          const isHolding = event.to === 'ready' && Boolean(job.holdReason)
          if (!wasHolding && isHolding) reviewCount.value += 1
          if (wasHolding && !isHolding) reviewCount.value = Math.max(0, reviewCount.value - 1)
          jobIndex.value = new Map(jobIndex.value)
          if (job.targetId === selectedConvId.value) upsertConvJob(job)
        }
        break
      }
      case 'jobUpdated': {
        patchJob(event.job)
        break
      }
      case 'conversationState': {
        convoStates.value = { ...convoStates.value, [event.convId]: event.state }
        updateRuntimeStatus()
        break
      }
      case 'conversationsChanged': {
        void loadConversations()
        break
      }
      case 'roundStarted': {
        if (status.value !== 'panic') status.value = 'running'
        break
      }
      case 'roundFinished': {
        pullSummary.value = event.summary
        pulling.value = false
        updateRuntimeStatus()
        break
      }
      case 'safetyChanged': {
        safety.value = event.snapshot
        break
      }
      case 'fuseTripped': {
        fuseBanner.value = { scope: event.scope, reason: event.reason, blocked: event.blocked }
        pushLog('warn', `${event.scope} 触发熔断（${event.reason}），本窗已拦 ${event.blocked} 条`)
        break
      }
      case 'settingsChanged': {
        settings.value = event.settings
        break
      }
      case 'log': {
        pushLog(event.level, event.text)
        break
      }
    }
  }

  /** 把新消息的汇总影响就地打到会话行上（O3 的冗余列在内存侧的镜像） */
  function patchConversationFromMessages(convId: string, rows: WelinkMessage[]) {
    if (!rows.length) return
    const conv = conversations.value.find((item) => item.convId === convId)
    if (!conv) return
    const incoming = rows.filter((item) => item.direction === 'in')
    conv.unreadCount += incoming.length
    conv.mentionCount += incoming.filter((item) => item.atMe && item.msgType === 'text').length
    const latest = rows.reduce((acc, item) => (item.sentAt > acc ? item.sentAt : acc), conv.lastMsgAt)
    conv.lastMsgAt = latest
    conv.lastActive = nowStamp()
    conversations.value = [...conversations.value]
  }

  /** 任务：更新索引 + 选中会话的待办列表 */
  function patchJob(job: WelinkJob) {
    jobIndex.value.set(job.pk, { ...job })
    jobIndex.value = new Map(jobIndex.value)
    if (job.targetId === selectedConvId.value) upsertConvJob(job)
  }

  function upsertConvJob(job: WelinkJob) {
    const open: JobStatus[] = ['pending', 'discussing', 'ready', 'sending', 'failed']
    const list = convJobs.value.filter((item) => item.pk !== job.pk)
    if (open.includes(job.status)) list.push({ ...job })
    convJobs.value = list.sort((a, b) =>
      a.createdAt === b.createdAt ? a.pk - b.pk : a.createdAt < b.createdAt ? -1 : 1,
    )
  }

  function updateRuntimeStatus() {
    if (safety.value.panic) {
      status.value = 'panic'
      return
    }
    if (!runtimeRunning()) {
      status.value = 'stopped'
      return
    }
    const states = Object.values(convoStates.value)
    if (states.some((item) => item.state === 'backoff')) {
      status.value = 'backoff'
      return
    }
    status.value = 'running'
  }

  function runtimeRunning(): boolean {
    return Boolean(runtime?.running())
  }

  function pushLog(level: 'info' | 'warn' | 'error', text: string) {
    const next = [{ at: nowStamp(), level, text }, ...logs.value]
    // P10：内存环形缓冲，最多 200 行
    logs.value = next.slice(0, 200)
  }

  // ---------------- 生命周期 ----------------

  /**
   * WeLink 表结构就绪（幂等，单进程只跑一次）。
   *
   * 为什么不能只依赖 bootstrap：`dbMigrateAll()` 原本只在「总开关打开」时才被调用，
   * 但本 store 一挂载就查会话表 —— 用户第一次进页面、还没开开关时会直接撞
   * "no such table"。数据层在这里补一次迁移，页面任何时候打开都是安全的。
   */
  async function ensureSchema() {
    try {
      await dbMigrateAll()
    } catch (error) {
      logger.error('WeLink 表结构初始化失败', error)
      pushLog('error', `表结构初始化失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** 载入页面时调用：只做只读装载，不启动调度（不点开关不该跑轮询） */
  async function init(next?: Partial<WelinkSettings>) {
    // P10：把编排层的 warn/error 接进 UI 内存环形缓冲（只接一次）
    if (!logUnsubscribe) {
      logUnsubscribe = onLog((level, text) => pushLog(level, text))
    }
    applySettings(next)
    status.value = 'init'
    await ensureSchema()
    await loadConversations()
    await refreshReviewCount()
    await refreshSafety()
    status.value = settingsReady() && runtimeRunning() ? 'running' : 'stopped'
  }

  function applySettings(next?: Partial<WelinkSettings>) {
    const merged = normalizeWelinkSettings(next ?? settings.value)
    settings.value = merged
    runtime?.reload(merged)
    safety.value = { ...safety.value, globalCap: merged.safety.globalHourlyCap }
  }

  function settingsReady(): boolean {
    return settings.value.enabled
  }

  async function ensureRuntime(): Promise<WelinkRuntime> {
    if (runtime) return runtime
    runtime = createWelinkRuntime({
      settings: () => settings.value,
      emit: onEvent,
    })
    return runtime
  }

  /** 总开关 ON（§6.4）：恢复 timer + worker，状态灯转「运行中」 */
  async function start(): Promise<BootstrapReport | null> {
    status.value = 'init'
    const active = await ensureRuntime()
    try {
      const report = await active.start()
      bootstrapReport.value = report
      for (const warning of report.warnings) pushLog('warn', warning)
      if (report.recoveredSent || report.requeued || report.enqueued) {
        pushLog(
          'info',
          `启动恢复：补记已发送 ${report.recoveredSent} · 回落重发 ${report.requeued} · 重新排队 ${report.enqueued}` +
            (report.failed ? ` · 保留待人工 ${report.failed}` : ''),
        )
      }
      await loadConversations()
      await refreshReviewCount()
      updateRuntimeStatus()
      return report
    } catch (error) {
      logger.error('WeLink 助手启动失败', error)
      pushLog('error', `启动失败：${error instanceof Error ? error.message : String(error)}`)
      status.value = 'stopped'
      return null
    }
  }

  /** 总开关 OFF：停 timer + worker，数据与未完成任务保留 */
  function stop() {
    runtime?.stop()
    status.value = 'stopped'
    pushLog('info', '助手已暂停，数据与未完成任务保留')
  }

  /** L0 一键全停：封死 Gate + 停调度 */
  function panicStop() {
    runtime?.gate.setPanic(true)
    runtime?.stop()
    status.value = 'panic'
    pushLog('warn', '已触发一键全停：所有外发被阻断，解除后默认转人工缓冲')
  }

  /**
   * 解除急停（§6.4）。
   *
   * 「解除后自动回复默认转 manual 再恢复」—— 这防的是「一解除就爆量」：
   * 急停期间积压的 pending 任务若直接放行，会瞬间涌出一堆回复。
   */
  function liftPanic(): { sendMode: 'manual' } {
    runtime?.gate.setPanic(false)
    settings.value = { ...settings.value, sendMode: 'manual' }
    runtime?.reload(settings.value)
    status.value = runtimeRunning() ? 'running' : 'stopped'
    pushLog('warn', '已解除急停：发送模式自动降为「人工确认」，确认无异常后可改回自动')
    return { sendMode: 'manual' }
  }

  /** 人工解除熔断（S8） */
  function resetFuse(scope?: string) {
    runtime?.gate.resetFuse(scope)
    fuseBanner.value = null
    void refreshSafety()
    pushLog('info', scope ? `已解除「${scope}」熔断` : '已解除全部熔断')
  }

  async function refreshSafety() {
    if (!runtime) return
    safety.value = runtime.gate.snapshot()
    if (safety.value.globalFuse) {
      fuseBanner.value = { scope: '全局', reason: safety.value.globalFuseReason, blocked: 0 }
    }
  }

  /** 立即拉取：与自动轮询共用 in-flight 锁，连点只会执行一次 */
  async function pullNow(): Promise<PollSummary> {
    if (!runtime) return { ...emptySummary() }
    pulling.value = true
    try {
      const summary = await runtime.pullNow()
      pullSummary.value = summary
      await loadConversations()
      await refreshReviewCount()
      return summary
    } finally {
      pulling.value = false
      updateRuntimeStatus()
    }
  }

  /**
   * 窗口可见性（P9）：隐藏时轮询间隔 ×3。
   * 视图只负责上报事件，降载策略由编排层决定 —— 视图不持有计时器。
   */
  function setPageVisible(visible: boolean) {
    runtime?.setVisible(visible)
  }

  // ---------------- 查询 ----------------

  async function loadConversations() {
    conversations.value = await repo().listConversations(CONVERSATION_PAGE_LIMIT, 0)
    conversationsLoaded.value = true
    // 超限不能静默（D-5）：此前这里硬编码 500，超过就**悄悄少一批** ——
    // 表现为「某个群怎么都不出现在列表里」，而用户完全看不出是分页截断。
    // 现在总表计数与返回条数一比，超限就明确告警（仍不自动翻页：会话列表是
    // 人工维护的白名单，量级到 500 时更该让用户看见而不是替它翻页）。
    if (conversations.value.length >= CONVERSATION_PAGE_LIMIT) {
      const total = await repo().countConversations()
      if (total > conversations.value.length) {
        logger.warn(
          `WeLink：会话列表已达上限（显示 ${conversations.value.length} / 共 ${total} 个），` +
            `超出部分未展示 —— 建议清理不再需要的会话`,
        )
      }
    }
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
       * 之前的问题是缓存只删不写、`check()` 永远未命中 —— 机制白搭。
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

  /** 选中会话：清未读 + 拉时间线 + 取该会话待办（§6.4 markRead O6） */
  async function selectConversation(convId: string, limit = 100) {
    selectedConvId.value = convId
    const conv = conversations.value.find((item) => item.convId === convId)
    if (!conv) return
    await repo().markRead(conv.pk)
    conv.unreadCount = 0
    conv.mentionCount = 0
    conversations.value = [...conversations.value]
    messages.value = await repo().listMessages({ convPk: conv.pk, limit })
    hasMoreMessages.value = messages.value.length >= limit
    convJobs.value = (
      await repo().listJobsByStatus(['pending', 'discussing', 'ready', 'sending', 'failed'], 200)
    ).filter((job) => job.targetId === convId)
    for (const job of convJobs.value) jobIndex.value.set(job.pk, job)
    jobIndex.value = new Map(jobIndex.value)
  }

  /** 向上翻页（P7：一次 100 条） */
  async function loadEarlierMessages(limit = 100) {
    const conv = conversations.value.find((item) => item.convId === selectedConvId.value)
    if (!conv || !messages.value.length) return
    const before = messages.value[0].sentAt
    const older = await repo().listMessages({ convPk: conv.pk, before, limit })
    if (older.length) {
      messages.value = [...older, ...messages.value]
      hasMoreMessages.value = older.length >= limit
    } else {
      hasMoreMessages.value = false
    }
  }

  // ---------------- 会话配置（R1 / O11） ----------------

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
    runtime?.poller.refreshConversations()
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
    runtime?.poller.refreshConversations()
  }

  async function updateConversation(
    convId: string,
    patch: Partial<Pick<WelinkConversation, 'title' | 'remark' | 'watching' | 'autoReply' | 'muteUntil'>>,
  ) {
    await repo().updateConversation(convId, patch)
    runtime?.gate.invalidateConversation(convId)
    // 关掉监控时联动关掉自动回复（watching=0 的会话不该继续外发）——§11.5 的约束
    if (patch.watching === false) {
      await repo().updateConversation(convId, { autoReply: false })
    }
    await loadConversations()
    runtime?.poller.refreshConversations()
    await refreshSafety()
  }

  async function setAutoReply(convIds: string[], enabled: boolean): Promise<number> {
    const changed = await repo().setAutoReply(convIds, enabled)
    for (const convId of convIds) runtime?.gate.invalidateConversation(convId)
    await loadConversations()
    await refreshSafety()
    return changed
  }

  /** O11 静音：1h / 8h / 今天 */
  async function muteConversation(convId: string, hours: number) {
    const until = new Date(Date.now() + hours * 3600 * 1000)
    await repo().updateConversation(convId, { muteUntil: nowStamp(until) })
    runtime?.gate.invalidateConversation(convId)
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
    runtime?.poller.refreshConversations()
  }

  // ---------------- 回复历史 / 回溯（R3 / R4） ----------------

  async function listJobs(query: Omit<JobQuery, 'limit' | 'offset'> & { limit: number; offset: number }) {
    const jobs = await repo().listJobs(query)
    for (const job of jobs) jobIndex.value.set(job.pk, job)
    jobIndex.value = new Map(jobIndex.value)
    return jobs
  }

  async function countJobs(query: Omit<JobQuery, 'limit' | 'offset'>) {
    return repo().countJobs(query)
  }

  async function jobStats() {
    const stamp = today()
    return repo().jobStats(`${stamp} 00:00:00`, `${stamp} ${nowStamp().slice(11, 13)}:00:00`)
  }

  /** 人工重发（失败/被拦任务）：回到 ready 入队，重发同样过 Gate */
  async function retryJob(jobPk: number): Promise<boolean> {
    const active = await ensureRuntime()
    return active.pipeline.sendNow(jobPk)
  }

  /** 编辑并发送（manual）：先落草稿再走外发（要点3） */
  async function editAndSend(jobPk: number, text: string): Promise<boolean> {
    await repo().updateDraft(jobPk, text)
    const active = await ensureRuntime()
    const ok = await active.pipeline.sendNow(jobPk)
    if (ok) pushLog('info', `已提交人工发送（job ${jobPk}）`)
    return ok
  }

  /** O10 评价 */
  async function rateJob(jobPk: number, rating: JobRating | null) {
    await repo().rateJob(jobPk, rating)
    const job = jobIndex.value.get(jobPk)
    if (job) {
      job.rating = rating
      jobIndex.value = new Map(jobIndex.value)
    }
  }

  async function listAgentLogs(jobPk: number): Promise<WelinkAgentLog[]> {
    return repo().listAgentLogs(jobPk)
  }

  async function listJobsWithLogs(limit = 50, offset = 0, onlyDownRated = false) {
    return repo().listJobsWithLogs(limit, offset, onlyDownRated)
  }

  async function countJobsWithLogs(onlyDownRated = false) {
    return repo().countJobsWithLogs(onlyDownRated)
  }

  /** 清理回溯记录（§10：语料含敏感对话） */
  async function clearAgentLogs(jobPk: number): Promise<number> {
    const removed = await repo().clearAgentLogs(jobPk)
    pushLog('warn', `已清理 job ${jobPk} 的 ${removed} 条回溯记录`)
    return removed
  }

  /**
   * 删除单条任务记录（§11.3 行操作）。
   *
   * 删除后必须同步三处内存视图，否则界面会显示一条点不开的幽灵行：任务索引、
   * 当前会话待办列表、待审计计数。触发消息与会话**不动** —— 这是仓储的语义边界。
   */
  async function removeJob(jobPk: number): Promise<boolean> {
    const removed = await repo().removeJob(jobPk)
    if (!removed) return false
    const job = jobIndex.value.get(jobPk)
    const wasHolding = Boolean(job && job.status === 'ready' && job.holdReason)
    jobIndex.value.delete(jobPk)
    jobIndex.value = new Map(jobIndex.value)
    convJobs.value = convJobs.value.filter((item) => item.pk !== jobPk)
    if (wasHolding) reviewCount.value = await repo().countHolding()
    return true
  }

  // ---------------- 收件箱 / 搜索（R2 / O12） ----------------

  async function listInbox(query: InboxQuery) {
    return repo().listInbox(query)
  }

  async function countInbox(query: Omit<InboxQuery, 'limit' | 'offset'>) {
    return repo().countInbox(query)
  }

  async function searchMessages(keyword: string, from?: string, to?: string, limit = 100, offset = 0) {
    return repo().searchMessages(keyword, from, to, limit, offset)
  }

  // ---------------- 演示剧本（O13） ----------------

  async function playDemoScript(): Promise<boolean> {
    const active = await ensureRuntime()
    // mock 端口额外带剧本能力；真实 CLI 端口没有 → 按钮置灰（O13 仅 mock 可用）
    const handle = active.port() as unknown as Partial<{ playScript: () => void }>
    if (typeof handle.playScript !== 'function') {
      pushLog('warn', '当前数据源不支持演示剧本（仅 mock 可用）')
      return false
    }
    handle.playScript()
    pushLog('info', '演示剧本已回放：等待轮询拉取「新人群聊 @我 → 私聊追问 → 对方回应」')
    // 立刻拉一轮，让评审看到完整链路（拉取 → 生成 → Gate → 外发）
    await pullNow()
    return true
  }

  // ---------------- 派生 ----------------

  /** 监控中的会话（左栏数据源，按最后消息倒序） */
  const watchingConversations = computed(() =>
    conversations.value
      .filter((item) => item.watching)
      .sort((a, b) => (a.lastMsgAt === b.lastMsgAt ? b.pk - a.pk : a.lastMsgAt < b.lastMsgAt ? 1 : -1)),
  )

  const selectedConversation = computed(
    () => conversations.value.find((item) => item.convId === selectedConvId.value) ?? null,
  )

  /**
   * 本轮轮询节奏预估（D-6）。
   *
   * 为什么由 store 派生而不是让设置页自己算：设置页只持有配置草稿，看不到
   * 「监控中的会话数」与「实际错峰」；而这两个数是「实际周期」的全部输入。
   * 放在这里 = 配置 + 运行时数据在唯一一处汇合，页面拿到的是**同一个数**。
   *
   * 三种数据来源（按可信度递减）：
   *  1. 已跑过一轮 → 用 `poller.currentStaggerMs()` 的**实测值**（最可信）；
   *  2. 装过会话清单 → 按监控数**预估**（`planPollRound`）；
   *  3. 都没装载（用户直接进设置页，没开过助手页）→ `known: false`，
   *     UI 不能显示「0 个会话」这种错话，只能提示「先打开助手页」或按 1 个估算。
   */
  function pollPlan(intervalSec?: number): PollRoundPlan & { known: boolean } {
    const sec = intervalSec ?? settings.value.pollIntervalSec
    const count = watchingConversations.value.length
    // 未装载且没有实测值 → 会话数不可知，不要用 0 冒充
    const known = conversationsLoaded.value || runtime?.poller.currentStaggerMs() != null
    const plan = planPollRound({ intervalSec: sec, conversationCount: count })
    if (!known)
      return {
        ...plan,
        conversationCount: 0,
        staggerMs: 0,
        staggerTotalMs: 0,
        periodMs: sec * 1000,
        converged: false,
        known: false,
      }

    const actualStagger = runtime?.poller.currentStaggerMs() ?? null
    if (actualStagger === null) return { ...plan, known: true }
    const staggerTotalMs = Math.max(0, plan.conversationCount - 1) * actualStagger
    return {
      ...plan,
      staggerMs: actualStagger,
      staggerTotalMs,
      roundMs: staggerTotalMs,
      periodMs: Math.max(0, sec) * 1000 + staggerTotalMs,
      converged: plan.conversationCount > 1 && actualStagger < POLL_STAGGER_MS,
      known: true,
    }
  }

  /** 未读总数（侧栏角标） */
  const unreadTotal = computed(() => conversations.value.reduce((sum, item) => sum + item.unreadCount, 0))

  /** 状态灯文案（§11.0） */
  const statusText = computed(() => {
    switch (status.value) {
      case 'init':
        return '初始化中'
      case 'running':
        return '运行中'
      case 'backoff':
        return '退避中'
      case 'panic':
        return '急停'
      case 'stopped':
        return '已停止'
      default:
        return '未启动'
    }
  })

  /** 配额徽标文案 */
  const quotaText = computed(() => {
    const closed = safety.value.globalClosedUntil ? ' · 全局冷却中' : ''
    return `本小时已回 ${safety.value.globalCount}/${safety.value.globalCap}${closed}`
  })

  const sourceBadge = computed(() => ({
    welink: settings.value.welinkSource,
    agent: settings.value.agent.agentSource,
    mock: settings.value.welinkSource === 'mock' || settings.value.agent.agentSource === 'mock' || platform !== 'tauri',
  }))

  const hasFuse = computed(() => safety.value.fuses.length > 0 || safety.value.globalFuse)

  function jobOf(pk: number): WelinkJob | null {
    return jobIndex.value.get(pk) ?? null
  }

  function skipLabel(reason: string): string {
    return SKIP_REASON_LABEL[reason] ?? reason
  }

  function holdLabel(reason: string): string {
    return HOLD_REASON_LABEL[reason as HoldReason] ?? reason
  }

  function statusLabel(value: JobStatus): string {
    return JOB_STATUS_LABEL[value]
  }

  return {
    // 状态
    settings,
    status,
    statusText,
    bootstrapReport,
    pullSummary,
    pulling,
    safety,
    fuseBanner,
    hasFuse,
    logs,
    quotaText,
    sourceBadge,
    // 数据
    conversations,
    watchingConversations,
    selectedConversation,
    selectedConvId,
    convoStates,
    messages,
    convJobs,
    hasMoreMessages,
    reviewCount,
    unreadTotal,
    /** 轮询节奏预估（D-6：设置页如实显示实际周期） */
    pollPlan,
    // 生命周期
    init,
    applySettings,
    start,
    stop,
    panicStop,
    liftPanic,
    resetFuse,
    refreshSafety,
    pullNow,
    setPageVisible,
    // 查询
    loadConversations,
    fetchConversations,
    countMessagesOf,
    refreshReviewCount,
    selectConversation,
    loadEarlierMessages,
    // 会话配置
    previewSync,
    syncConversations,
    upsertConversation,
    updateConversation,
    setAutoReply,
    muteConversation,
    removeConversation,
    // 历史 / 回溯
    listJobs,
    countJobs,
    jobStats,
    retryJob,
    editAndSend,
    rateJob,
    listAgentLogs,
    listJobsWithLogs,
    countJobsWithLogs,
    clearAgentLogs,
    removeJob,
    // 收件箱 / 搜索
    listInbox,
    countInbox,
    searchMessages,
    // 演示
    playDemoScript,
    // 工具
    jobOf,
    skipLabel,
    holdLabel,
    statusLabel,
  }
})

/** 仓储读取（浏览器模式自动落到内存实现，Q3/D5） */
function repo(): WelinkRepository {
  return welink()
}
