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
 *
 * 内部结构（quality-hardening-2026-10 D1）：本文件是**唯一公共 facade**——状态
 * 容器 + 装配；实现按域拆在同目录 events / view / control / data / aggregate，
 * 消费方（views/components）的 import 路径与用法零改动。
 */
import { computed, ref, shallowRef } from 'vue'
import { defineStore } from 'pinia'

import { platform } from '@/api'
import type { WelinkRepository } from '@/infra/db'
import type { ConversationState, PollSummary, SafetySnapshot, WelinkEvent } from '@/orchestrator/events'
import { emptySummary } from '@/orchestrator/events'
import { createWelinkRuntime, type WelinkRuntime } from '@/orchestrator/runtime'
import type { BootstrapReport } from '@/orchestrator/bootstrap'
import { getWelinkRepo } from '@/orchestrator/welink-storage'
import {
  DEFAULT_WELINK_SETTINGS,
  type WelinkConversation,
  type WelinkJob,
  type WelinkMessage,
  type WelinkSettings,
} from '@/types/welink'
import { onLog } from '@/utils/logger'
import { nowStamp } from '@/utils/time'
import type { PollRoundPlan } from '@/utils/poll'
import {
  derivePollPlan,
  holdLabelOf,
  skipLabelOf,
  sortWatchingDesc,
  sourceBadgeOf,
  statusLabelOf,
  statusTextOf,
  unreadTotalOf,
  quotaTextOf,
  type RuntimeStatus,
} from './aggregate'
import { createEventConsumer, type FuseBanner } from './events'
import { createConversationView } from './view'
import { createRuntimeControl } from './control'
import { createWelinkData } from './data'

export type { RuntimeStatus } from './aggregate'

/** 日志旁路只订阅一次（模块级，避免 store 重建时重复叠加订阅） */
let logUnsubscribe: (() => void) | null = null
/** init() 装配的订阅执行器：让退订后的重新进入页面能重建订阅（keep-alive 复活路径） */
let logSubscribe: (() => void) | null = null

/**
 * 订阅日志旁路（幂等；未 init 前调用是安全的 no-op）。
 */
export function subscribeWelinkLogs(): void {
  logSubscribe?.()
}

/**
 * 退订日志旁路（D-9）。
 *
 * 为什么需要：模块级单例 + 守卫使得**重复订阅不会发生**，但「声明了退订函数
 * 却永不调用」是一句没兑现的承诺 —— 将来若把 store 改成非单例（如多实例/热重载
 * 场景），它会立刻变成一个真实的引用泄漏。
 *
 * 调用时机：页面失活（`WeLinkView.onDeactivated` —— MainLayout 对所有路由组件套了
 * keep-alive，正常导航不触发 onUnmounted）与测试的 `afterEach`。
 * 复活路径：`onActivated` → `subscribeWelinkLogs()` 重建订阅。
 * 注意退订后**不能**清 `logs`：日志是用户的诊断信息，离开页面不该抹掉它。
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
  const fuseBanner = ref<FuseBanner | null>(null)
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

  // ---------------- 共享机制（跨域装配点） ----------------

  /** 编排层运行时持有者：延迟创建（首次 start 时才装配，避免点开页面就建端口） */
  const runtimeHolder: { current: WelinkRuntime | null } = { current: null }
  /** 事件消费的晚绑定：runtime 装配先于 events 模块创建（见下方装配顺序） */
  let onEventImpl: ((event: WelinkEvent) => void) | null = null

  function pushLog(level: 'info' | 'warn' | 'error', text: string) {
    const next = [{ at: nowStamp(), level, text }, ...logs.value]
    // P10：内存环形缓冲，最多 200 行
    logs.value = next.slice(0, 200)
  }

  function ensureRuntime(): Promise<WelinkRuntime> {
    if (runtimeHolder.current) return Promise.resolve(runtimeHolder.current)
    runtimeHolder.current = createWelinkRuntime({
      settings: () => settings.value,
      emit: (event) => onEventImpl?.(event),
    })
    return Promise.resolve(runtimeHolder.current)
  }

  /** 安全快照刷新（view.updateConversation 与 control 共用的横切动作） */
  async function refreshSafety() {
    const runtime = runtimeHolder.current
    if (!runtime) return
    safety.value = runtime.gate.snapshot()
    if (safety.value.globalFuse) {
      fuseBanner.value = { scope: '全局', reason: safety.value.globalFuseReason, blocked: 0 }
    }
  }

  /** 存储网关（orchestrator/welink-storage）：store 不直连 infra/db（D2） */
  const repo = (): WelinkRepository => getWelinkRepo()

  /** 日志旁路装配（D-9）：幂等；keep-alive 复活经 subscribeWelinkLogs 重建 */
  function ensureLogSubscription() {
    if (!logSubscribe) {
      logSubscribe = () => {
        if (!logUnsubscribe) {
          logUnsubscribe = onLog((level, text) => pushLog(level, text))
        }
      }
    }
    logSubscribe()
  }

  // ---------------- 按域装配（依赖顺序：view → control → events → data） ----------------

  const view = createConversationView({
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
  })

  const control = createRuntimeControl({
    status,
    settings,
    safety,
    fuseBanner,
    pullSummary,
    pulling,
    bootstrapReport,
    convoStates,
    runtimeHolder,
    ensureRuntime,
    ensureLogSubscription,
    pushLog,
    loadConversations: view.loadConversations,
    refreshReviewCount: view.refreshReviewCount,
    refreshSafety,
  })

  const consumer = createEventConsumer({
    selectedConvId,
    messages,
    conversations,
    convoStates,
    jobIndex,
    convJobs,
    status,
    pullSummary,
    pulling,
    safety,
    fuseBanner,
    settings,
    reviewCount,
    loadConversations: view.loadConversations,
    updateRuntimeStatus: control.updateRuntimeStatus,
    pushLog,
  })
  onEventImpl = consumer.onEvent

  const data = createWelinkData({
    jobIndex,
    convJobs,
    reviewCount,
    repo,
    ensureRuntime,
    pushLog,
    pullNow: control.pullNow,
  })

  // ---------------- 派生（聚合口径唯一，实现委托 aggregate 纯函数） ----------------

  /** 监控中的会话（左栏数据源，按最后消息倒序） */
  const watchingConversations = computed(() => sortWatchingDesc(conversations.value))

  const selectedConversation = computed(
    () => conversations.value.find((item) => item.convId === selectedConvId.value) ?? null,
  )

  /**
   * 本轮轮询节奏预估（D-6）。
   *
   * 为什么由 store 派生而不是让设置页自己算：设置页只持有配置草稿，看不到
   * 「监控中的会话数」与「实际错峰」；而这两个数是「实际周期」的全部输入。
   * 放在这里 = 配置 + 运行时数据在唯一一处汇合，页面拿到的是**同一个数**。
   */
  function pollPlan(intervalSec?: number): PollRoundPlan & { known: boolean } {
    return derivePollPlan({
      intervalSec: intervalSec ?? settings.value.pollIntervalSec,
      watchingCount: watchingConversations.value.length,
      loaded: conversationsLoaded.value,
      actualStaggerMs: runtimeHolder.current?.poller.currentStaggerMs() ?? null,
    })
  }

  /** 未读总数（侧栏角标） */
  const unreadTotal = computed(() => unreadTotalOf(conversations.value))

  /** 状态灯文案（§11.0） */
  const statusText = computed(() => statusTextOf(status.value))

  /** 配额徽标文案 */
  const quotaText = computed(() => quotaTextOf(safety.value))

  const sourceBadge = computed(() => sourceBadgeOf(settings.value, platform))

  const hasFuse = computed(() => safety.value.fuses.length > 0 || safety.value.globalFuse)

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
    init: control.init,
    applySettings: control.applySettings,
    start: control.start,
    stop: control.stop,
    panicStop: control.panicStop,
    liftPanic: control.liftPanic,
    resetFuse: control.resetFuse,
    refreshSafety,
    pullNow: control.pullNow,
    setPageVisible: control.setPageVisible,
    // 查询
    loadConversations: view.loadConversations,
    fetchConversations: view.fetchConversations,
    countMessagesOf: view.countMessagesOf,
    refreshReviewCount: view.refreshReviewCount,
    selectConversation: view.selectConversation,
    loadEarlierMessages: view.loadEarlierMessages,
    // 会话配置
    previewSync: view.previewSync,
    syncConversations: view.syncConversations,
    upsertConversation: view.upsertConversation,
    updateConversation: view.updateConversation,
    setAutoReply: view.setAutoReply,
    muteConversation: view.muteConversation,
    removeConversation: view.removeConversation,
    // 历史 / 回溯
    listJobs: data.listJobs,
    countJobs: data.countJobs,
    jobStats: data.jobStats,
    retryJob: data.retryJob,
    editAndSend: data.editAndSend,
    rateJob: data.rateJob,
    listAgentLogs: data.listAgentLogs,
    listJobsWithLogs: data.listJobsWithLogs,
    countJobsWithLogs: data.countJobsWithLogs,
    clearAgentLogs: data.clearAgentLogs,
    removeJob: data.removeJob,
    // 收件箱 / 搜索
    listInbox: data.listInbox,
    countInbox: data.countInbox,
    searchMessages: data.searchMessages,
    // 演示
    playDemoScript: data.playDemoScript,
    // 诊断（Agent 连通性探测，V1 治理后 UI 经 store 使用）
    probeAgent: data.probeAgent,
    probeRag: data.probeRag,
    // 沉淀评审入口（knowledge-sedimentation：harvester 收口逻辑经 runtime 暴露）
    ensureRuntime,
    // 工具
    jobOf: (pk: number): WelinkJob | null => jobIndex.value.get(pk) ?? null,
    skipLabel: skipLabelOf,
    holdLabel: holdLabelOf,
    statusLabel: statusLabelOf,
  }
})
