/**
 * 运行控制层（quality-hardening-2026-10 D1）—— 生命周期与运行时控制：
 * init / start / stop / L0 急停 / 熔断解除 / 立即拉取 / 状态灯推导。
 *
 * 「动作即映射」（§6.4）：本层方法是 UI 按钮到编排层的薄转发 + 本地状态同步；
 * 业务规则全部在 orchestrator（bootstrap/poller/pipeline/safety-gate）。
 */
import type { Ref } from 'vue'

import { normalizeWelinkSettings, type WelinkSettings } from '@/types/welink'
import { logger } from '@/utils/logger'
import type { WelinkRuntime } from '@/orchestrator/runtime'
import type { BootstrapReport } from '@/orchestrator/bootstrap'
import { emptySummary, type ConversationState, type PollSummary, type SafetySnapshot } from '@/orchestrator/events'
import { ensureWelinkStorage } from '@/orchestrator/welink-storage'
import type { RuntimeStatus } from './aggregate'
import type { FuseBanner } from './events'

export interface RuntimeControlDeps {
  status: Ref<RuntimeStatus>
  settings: Ref<WelinkSettings>
  safety: Ref<SafetySnapshot>
  fuseBanner: Ref<FuseBanner | null>
  pullSummary: Ref<PollSummary>
  pulling: Ref<boolean>
  bootstrapReport: Ref<BootstrapReport | null>
  convoStates: Ref<Record<string, ConversationState>>
  /** 编排层运行时持有者（index 持有；ensureRuntime 由 index 提供） */
  runtimeHolder: { current: WelinkRuntime | null }
  ensureRuntime: () => Promise<WelinkRuntime>
  /** 日志旁路重建（index 的模块级单例机制，D-9 keep-alive 复活路径） */
  ensureLogSubscription: () => void
  pushLog: (level: 'info' | 'warn' | 'error', text: string) => void
  /** 跨模块协作（view 域，index 装配后传入） */
  loadConversations: () => Promise<void>
  refreshReviewCount: () => Promise<void>
  /** 安全快照刷新（index 持有的共享函数） */
  refreshSafety: () => Promise<void>
}

export interface RuntimeControl {
  init(next?: Partial<WelinkSettings>): Promise<{ panicRecovered: boolean }>
  applySettings(next?: Partial<WelinkSettings>): void
  start(): Promise<BootstrapReport | null>
  stop(): void
  panicStop(): void
  liftPanic(): { sendMode: 'manual' }
  resetFuse(scope?: string): void
  pullNow(): Promise<PollSummary>
  setPageVisible(visible: boolean): void
  updateRuntimeStatus(): void
  runtimeRunning(): boolean
}

export function createRuntimeControl(deps: RuntimeControlDeps): RuntimeControl {
  const {
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
    loadConversations,
    refreshReviewCount,
    refreshSafety,
  } = deps

  function runtimeRunning(): boolean {
    return Boolean(runtimeHolder.current?.running())
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

  /**
   * WeLink 表结构就绪（幂等，单进程只跑一次）。
   *
   * 为什么不能只依赖 bootstrap：迁移原本只在「总开关打开」时才被调用，
   * 但本 store 一挂载就查会话表 —— 用户第一次进页面、还没开开关时会直接撞
   * "no such table"。数据层在这里补一次迁移，页面任何时候打开都是安全的。
   */
  async function ensureSchema() {
    try {
      await ensureWelinkStorage()
    } catch (error) {
      logger.error('WeLink 表结构初始化失败', error)
      pushLog('error', `表结构初始化失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /**
   * 载入页面时调用：只做只读装载，不启动调度（不点开关不该跑轮询）。
   * 返回 `panicRecovered`：上次会话以急停结束时为 true —— 降级已在本 store
   * 生效，调用方需把它写回持久层并显式告知用户（appStore 归视图持有）。
   */
  async function init(next?: Partial<WelinkSettings>): Promise<{ panicRecovered: boolean }> {
    ensureLogSubscription()
    applySettings(next)
    // 急停跨重启不复活（评审 P1）：读到落盘的 panicked 标记 → 强制人工确认模式，
    // bootstrap 恢复的 ready 任务就不会继续自动外发。标记在此复位（内存态），
    // 持久层的复位由调用方写回。
    let panicRecovered = false
    if (settings.value.panicked) {
      settings.value = { ...settings.value, sendMode: 'manual', panicked: false }
      panicRecovered = true
      pushLog('warn', '上次会话以「一键全停」结束：已降为人工确认模式，未自动恢复外发')
    }
    status.value = 'init'
    await ensureSchema()
    await loadConversations()
    await refreshReviewCount()
    await refreshSafety()
    status.value = settings.value.enabled && runtimeRunning() ? 'running' : 'stopped'
    return { panicRecovered }
  }

  function applySettings(next?: Partial<WelinkSettings>) {
    const merged = normalizeWelinkSettings(next ?? settings.value)
    settings.value = merged
    runtimeHolder.current?.reload(merged)
    safety.value = { ...safety.value, globalCap: merged.safety.globalHourlyCap }
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
    runtimeHolder.current?.stop()
    status.value = 'stopped'
    pushLog('info', '助手已暂停，数据与未完成任务保留')
  }

  /** L0 一键全停：封死 Gate + 停调度 */
  function panicStop() {
    runtimeHolder.current?.gate.setPanic(true)
    runtimeHolder.current?.stop()
    // 急停标记落盘（评审 P1）：panic 原为纯内存态，重启后 ready 任务会按原
    // sendMode 恢复自动外发。持久化由调用方（视图写 appStore）完成——
    // 本 store 不反向依赖 appStore（防环依赖）。
    settings.value = { ...settings.value, panicked: true }
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
    runtimeHolder.current?.gate.setPanic(false)
    settings.value = { ...settings.value, sendMode: 'manual', panicked: false }
    runtimeHolder.current?.reload(settings.value)
    status.value = runtimeRunning() ? 'running' : 'stopped'
    pushLog('warn', '已解除急停：发送模式自动降为「人工确认」，确认无异常后可改回自动')
    return { sendMode: 'manual' }
  }

  /** 人工解除熔断（S8） */
  function resetFuse(scope?: string) {
    runtimeHolder.current?.gate.resetFuse(scope)
    fuseBanner.value = null
    void refreshSafety()
    pushLog('info', scope ? `已解除「${scope}」熔断` : '已解除全部熔断')
  }

  /** 立即拉取：与自动轮询共用 in-flight 锁，连点只会执行一次 */
  async function pullNow(): Promise<PollSummary> {
    if (!runtimeHolder.current) return { ...emptySummary() }
    pulling.value = true
    try {
      const summary = await runtimeHolder.current.pullNow()
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
    runtimeHolder.current?.setVisible(visible)
  }

  return {
    init,
    applySettings,
    start,
    stop,
    panicStop,
    liftPanic,
    resetFuse,
    pullNow,
    setPageVisible,
    updateRuntimeStatus,
    runtimeRunning,
  }
}
