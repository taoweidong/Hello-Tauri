/**
 * 环境检测 store —— 检测页唯一的状态层。
 *
 * 职责边界（与 welink store 同款三条）：
 *  1. **检测是渐进呈现的**：每项完成就地上屏，不等最慢的一项 —— 首项秒回，
 *     用户不需要盯着全屏 loading；
 *  2. **代次守卫是硬约束**：重新检测/取消后，上一轮的迟到结果一律丢弃。
 *     检测可能比用户的下一次操作更慢（硬超时最长 16s），没有代次守卫就会出现
 *     「点了重新检测，先弹回一轮旧结论」的错乱；
 *  3. **动作即映射**：runAll / runOne / cancelPending 三个动作对应页面三个按钮，
 *     业务（探测、超时、异常折叠）全在 `infra/envcheck`。
 *
 * 为什么检测逻辑不进 orchestrator：环境检测是**无状态只读诊断**，没有轮询、
 * 持久化、恢复这些编排层职责，store → infra 直连即可（与快速建群 store 消费
 * `groupClient` 同款先例）。
 */
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'

import { platform } from '@/api'
import { createEnvChecks, type EnvCheckItem, type EnvCheckOutcome, type EnvCheckStep } from '@/infra/envcheck'
import { normalizeWelinkSettings } from '@/types/welink'
import { nowStamp } from '@/utils/time'
import { useAppStore } from '@/stores/app'

/** 单个检测项在 UI 里的状态（'idle' | 'running' + 探测结果状态） */
export type EnvCheckRunStatus = 'idle' | 'running' | 'ok' | 'warn' | 'fail' | 'timeout'

export interface EnvCheckItemState {
  id: string
  name: string
  description: string
  status: EnvCheckRunStatus
  summary: string
  details: string
  steps: EnvCheckStep[]
  durationMs: number | null
  finishedAt: string | null
}

/** 页面级汇总（横幅与标题徽标的依据） */
export type EnvCheckOverall = 'idle' | 'running' | 'partial' | 'pass' | 'warn' | 'fail'

function blankState(item: EnvCheckItem): EnvCheckItemState {
  return {
    id: item.id,
    name: item.name,
    description: item.description,
    status: 'idle',
    summary: '',
    details: '',
    steps: [],
    durationMs: null,
    finishedAt: null,
  }
}

export const useEnvCheckStore = defineStore('envcheck', () => {
  const appStore = useAppStore()

  const items = ref<EnvCheckItemState[]>([])
  const lastRunAt = ref<string | null>(null)
  /** 代次号：每次 runAll/runOne 递增；apply 时代次不符即丢弃（竞态守卫） */
  let runSeq = 0

  /**
   * 数据源模式：浏览器强制 mock（无子进程通道，与 welink 端口工厂同款兜底）。
   * 注意与 welinkSource 开关无关 —— 环境检测测的是**本机装没装 CLI**，
   * 数据源还挂在 mock 的用户同样需要（且更需要）知道真实环境是否就绪。
   */
  const mode = computed<'cli' | 'mock'>(() => (platform === 'tauri' ? 'cli' : 'mock'))

  const running = computed(() => items.value.some((item) => item.status === 'running'))

  const overall = computed<EnvCheckOverall>(() => {
    const list = items.value
    if (!list.length || list.every((item) => item.status === 'idle')) return 'idle'
    if (running.value) return 'running'
    // 有结果也有未检测（典型：中途取消）—— 如实标 partial，横幅提示补测
    if (list.some((item) => item.status === 'idle')) return 'partial'
    if (list.some((item) => item.status === 'fail' || item.status === 'timeout')) return 'fail'
    if (list.some((item) => item.status === 'warn')) return 'warn'
    return 'pass'
  })

  /**
   * 组装检测清单（幂等）：按当前配置重建，已有结果按 id 保留。
   * 每次 run 前都会调用 —— 用户改了 cliPath 再回来点检测，立即用新路径。
   */
  function ensureItems(): EnvCheckItem[] {
    const welinkSettings = normalizeWelinkSettings(appStore.settings.weLink)
    const checks = createEnvChecks({ mode: mode.value, welink: { cliPath: welinkSettings.cliPath } })
    const previous = new Map(items.value.map((state) => [state.id, state]))
    items.value = checks.map((check) => {
      const old = previous.get(check.id)
      // 名称/描述随配置刷新（描述里含路径），结果状态原样保留
      return old ? { ...old, name: check.name, description: check.description } : blankState(check)
    })
    return checks
  }

  function applyOutcome(id: string, outcome: EnvCheckOutcome) {
    const target = items.value.find((state) => state.id === id)
    if (!target) return
    target.status = outcome.status
    target.summary = outcome.summary
    target.details = outcome.details ?? ''
    target.steps = outcome.steps
    target.durationMs = outcome.durationMs
    target.finishedAt = nowStamp()
    lastRunAt.value = target.finishedAt
    items.value = [...items.value]
  }

  /** 跑单个检测项（行内「重测」按钮用）。代次守卫与 runAll 共用一个计数器 */
  async function runOne(id: string) {
    const checks = ensureItems()
    const check = checks.find((item) => item.id === id)
    if (!check) return
    const seq = ++runSeq
    const state = items.value.find((item) => item.id === id)
    if (!state) return
    state.status = 'running'
    state.summary = '检测中…'
    state.details = ''
    state.steps = []
    items.value = [...items.value]

    // 工厂层已保证 run 永不 reject、必在硬超时内 resolve —— 这里无需 try/catch
    const outcome = await check.run()
    if (seq !== runSeq) return
    applyOutcome(id, outcome)
  }

  /** 全量检测：并行跑所有项，逐项完成就地上屏 */
  async function runAll() {
    const checks = ensureItems()
    const seq = ++runSeq
    const byId = new Map(checks.map((check) => [check.id, check]))
    // 先全部置 running（按钮立即转 loading），完成一项落一项
    items.value = items.value.map((state) =>
      byId.has(state.id)
        ? {
            ...state,
            status: 'running',
            summary: '检测中…',
            details: '',
            steps: [],
            durationMs: null,
            finishedAt: null,
          }
        : state,
    )

    await Promise.all(
      items.value.map(async (state) => {
        const check = byId.get(state.id)
        if (!check) return
        const outcome = await check.run()
        if (seq !== runSeq) return
        applyOutcome(state.id, outcome)
      }),
    )
  }

  /**
   * 取消未决检测（离开页面 / 手动取消）。
   *
   * 只做「结果不再回填」+ 把 running 项复位为 idle，**不真正终止子进程** ——
   * TS 侧没有杀进程的通道，进程回收由 Rust 侧超时兜底（见 port.ts 硬超时注释）。
   * 迟到的结果被代次守卫丢弃，不会污染下一次检测。
   */
  function cancelPending() {
    runSeq += 1
    if (!running.value) return
    items.value = items.value.map((state) =>
      state.status === 'running'
        ? {
            ...state,
            status: 'idle',
            summary: '已取消（本次未等待结果返回）',
            steps: [],
            durationMs: null,
            finishedAt: null,
          }
        : state,
    )
  }

  return {
    items,
    mode,
    running,
    overall,
    lastRunAt,
    runAll,
    runOne,
    cancelPending,
  }
})
