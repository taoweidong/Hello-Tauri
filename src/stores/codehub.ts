/**
 * CodeHub 检视 store（personal-workbench）—— UI 与「数据层 + 编排层」之间唯一的状态层。
 *
 * D2 组合点例外：本 store 消费 infra 工厂做**装配**（`codeHubPort` / `codehub()` /
 * `createCodeHubSyncer` / `createDetailBackfill`），与 envcheck/table/group 的先例
 * 同款——业务编排仍在 orchestrator（退避、auth 终止、事件序列在 codehub-sync，
 * 详情补拉与去重在 codehub-detail），快照规则在仓储层（覆盖写、事务），
 * 这里只做状态聚合与动作转发，不做二次实现。
 */
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'

import { codeHubPort } from '@/infra/codehub'
import type { CodeHubVerifyResult } from '@/infra/codehub'
import { codehub, dbMigrateAll } from '@/infra/db'
import type { CodeHubMrQuery } from '@/infra/db/codehub-ports'
import { createDetailBackfill, type CodeHubDetailBackfill } from '@/orchestrator/codehub-detail'
import {
  codeHubConfigured,
  createCodeHubSyncer,
  SYNC_MIN_INTERVAL_SEC,
  type CodeHubSyncer,
} from '@/orchestrator/codehub-sync'
import type { CodeHubEvent, CodeHubSyncSummary } from '@/orchestrator/events'
import type { CodeHubMrRecord, CodeHubRepo, CodeHubSettings, CodeHubSyncState } from '@/types/codehub'
import { normalizeCodeHubSettings } from '@/types/codehub'
import { logger, registerSecret } from '@/utils/logger'
import { useAppStore } from '@/stores/app'

/** 仓库清单一次读取的硬上限（与同步管线侧同值，UI 只展示不翻页） */
export const REPO_LIST_LIMIT = 100

export const useCodehubStore = defineStore('codehub', () => {
  // ---------------- 状态 ----------------
  const repos = ref<CodeHubRepo[]>([])
  /** 每仓库同步状态（键 = repoId；从未同步的仓库无条目） */
  const syncStates = ref<Record<string, CodeHubSyncState>>({})
  /** 同步进行中（事件驱动；手动刷新与自动轮询共用） */
  const syncing = ref(false)
  /** 最近一轮同步摘要（状态条与 toast 的数据源） */
  const lastSummary = ref<CodeHubSyncSummary | null>(null)
  const autoOn = ref(false)
  /** 当前退避秒数（0 = 无退避），状态条显示「退避中」 */
  const backoffSec = ref(0)

  let initialized = false
  /** 并发装载去重（App.vue 启动装配与页面 onMounted 可能同时进来） */
  let initTask: Promise<boolean> | null = null
  let syncer: CodeHubSyncer | null = null
  let backfill: CodeHubDetailBackfill | null = null

  /** 每次取最新设置（normalize 兜底；配置改动下一轮同步即生效） */
  function settings(): CodeHubSettings {
    return normalizeCodeHubSettings(useAppStore().settings.codeHub)
  }

  /** 检视域是否配置齐备：cli 模式要求路径 + token；mock 恒就绪（spec「未配置引导态」的判定口径） */
  const configured = computed(() => codeHubConfigured(settings()))
  const source = computed(() => settings().source)
  const pollIntervalSec = computed(() => settings().pollIntervalSec)
  /** 实际生效间隔（自动同步运行中）：配置低于下限会被管线钳到 SYNC_MIN_INTERVAL_SEC */
  const effectiveIntervalSec = computed(() => Math.max(SYNC_MIN_INTERVAL_SEC, pollIntervalSec.value))

  function onEvent(event: CodeHubEvent): void {
    if (event.type === 'codehubSyncStarted') {
      syncing.value = true
    } else if (event.type === 'codehubSyncFinished') {
      syncing.value = false
      lastSummary.value = event.summary
      backoffSec.value = syncer?.backoffSec() ?? 0
    }
  }

  function syncerFor(): CodeHubSyncer {
    if (!syncer) {
      syncer = createCodeHubSyncer({
        repo: codehub(),
        port: () => codeHubPort({ settings: settings() }),
        settings,
        emit: onEvent,
      })
    }
    return syncer
  }

  // ---------------- 生命周期 ----------------

  /** 装载（App 启动装配 / 检视页 / 设置卡挂载共用，进程内幂等且并发去重） */
  function init(): Promise<boolean> {
    registerSecret(settings().token)
    if (!initTask) {
      initTask = initOnce().then((ok) => {
        // 失败不缓存：页面的「重试」与下次进入都要真再试一次
        if (!ok) initTask = null
        return ok
      })
    }
    return initTask
  }

  async function initOnce(): Promise<boolean> {
    try {
      await dbMigrateAll()
    } catch (error) {
      logger.error('CodeHub 表结构初始化失败', error)
      return false
    }
    await Promise.all([loadRepos(), loadSyncStates()])
    initialized = true
    // 应用级装配：轮询生命周期归 store 单例，不随页面卸载消失（spec「轮询间隔生效」）
    applyAutoSettings()
    return true
  }

  async function loadRepos(): Promise<void> {
    try {
      repos.value = await codehub().listRepos(REPO_LIST_LIMIT)
    } catch (error) {
      logger.error('装载仓库清单失败', error)
    }
  }

  async function loadSyncStates(): Promise<void> {
    try {
      syncStates.value = Object.fromEntries((await codehub().listSyncStates()).map((state) => [state.repoId, state]))
    } catch (error) {
      logger.error('装载同步状态失败', error)
    }
  }

  // ---------------- 仓库注册 ----------------

  async function addRepo(repoId: string, name: string): Promise<void> {
    const id = repoId.trim()
    if (!id) throw new Error('仓库标识不能为空')
    await codehub().addRepo(id, name.trim() || id)
    logger.info(`已注册仓库 ${id}`)
    await loadRepos()
  }

  async function removeRepo(pk: number): Promise<void> {
    const changed = await codehub().removeRepo(pk)
    if (!changed) throw new Error('仓库不存在或已被删除')
    await Promise.all([loadRepos(), loadSyncStates()])
  }

  async function setRepoEnabled(pk: number, enabled: boolean): Promise<void> {
    const changed = await codehub().setRepoEnabled(pk, enabled)
    if (!changed) throw new Error('仓库不存在或已被删除')
    await loadRepos()
  }

  // ---------------- 快照查询（筛选/分页由视图持有，store 不复制状态） ----------------

  function listMrs(query: CodeHubMrQuery) {
    return codehub().listMrs(query)
  }

  function countMrs(query: Omit<CodeHubMrQuery, 'limit' | 'offset'>) {
    return codehub().countMrs(query)
  }

  /**
   * 取单条 MR：详情补拉的规则在 `orchestrator/codehub-detail`（快照优先、去重、
   * 失败不 reject），这里只按 D8 装配端口与仓储。
   */
  function getMr(repoId: string, mrIid: string): Promise<CodeHubMrRecord | null> {
    return backfillFor().fetch(repoId, mrIid)
  }

  function backfillFor(): CodeHubDetailBackfill {
    if (!backfill) {
      backfill = createDetailBackfill({
        repo: codehub(),
        port: () => codeHubPort({ settings: settings() }),
      })
    }
    return backfill
  }

  // ---------------- 同步 ----------------

  /** 手动刷新（永不 reject，摘要直接可用）：完成后刷新同步状态供状态条展示 */
  async function refresh(): Promise<CodeHubSyncSummary> {
    const summary = await syncerFor().refresh()
    await loadSyncStates()
    return summary
  }

  function startAuto(): void {
    syncerFor().startAuto()
    autoOn.value = syncerFor().autoRunning()
  }

  function stopAuto(): void {
    syncerFor().stopAuto()
    autoOn.value = false
  }

  /** 配置变更后重评估自动同步：已开启且间隔归零 → 停；未开启且可跑 → 启 */
  function applyAutoSettings(): void {
    const interval = settings().pollIntervalSec
    if (autoOn.value && interval <= 0) {
      stopAuto()
      logger.info('CodeHub 自动同步已关闭（间隔归零）')
      return
    }
    if (!autoOn.value && interval > 0 && configured.value && initialized) startAuto()
  }

  // ---------------- 连通验证（设置卡用） ----------------

  /**
   * 验证连通性。`overrides` 允许用**表单草稿**验证（不必先保存）；
   * 未配置齐备时直接给出引导性失败结果，不发任何调用（spec 引导态）。
   */
  async function verifyConnection(overrides?: Partial<CodeHubSettings>): Promise<CodeHubVerifyResult> {
    const merged = normalizeCodeHubSettings({ ...settings(), ...overrides })
    registerSecret(merged.token)
    if (!codeHubConfigured(merged)) {
      return { ok: false, detail: '未配置完整：请填写 CLI 路径与访问 token' }
    }
    return codeHubPort({ settings: merged }).verifyConnection()
  }

  /** 测试用：丢弃 syncer/backfill 单例与初始化标记 */
  function _resetForTest(): void {
    syncer?.dispose()
    syncer = null
    backfill?.reset()
    backfill = null
    initialized = false
    initTask = null
    syncing.value = false
    lastSummary.value = null
    autoOn.value = false
    backoffSec.value = 0
  }

  return {
    repos,
    syncStates,
    syncing,
    lastSummary,
    autoOn,
    backoffSec,
    configured,
    source,
    pollIntervalSec,
    effectiveIntervalSec,
    init,
    loadRepos,
    loadSyncStates,
    addRepo,
    removeRepo,
    setRepoEnabled,
    listMrs,
    countMrs,
    getMr,
    refresh,
    startAuto,
    stopAuto,
    applyAutoSettings,
    verifyConnection,
    _resetForTest,
  }
})
