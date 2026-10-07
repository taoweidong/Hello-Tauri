/**
 * 知识库 × 知识沉淀 store（knowledge-sedimentation K-G / D2 组合点）。
 *
 * 为什么单独一个 store 而不并入 welink store：知识库管理（KnowledgeCard）与沉淀
 * 评审（SedimentCard）是设置页的两个独立面板，不依赖回复链路的运行时状态；但
 * 评审动作需要 harvester（写知识库 + 置终态的收口逻辑住那里），经 welink store
 * 的 ensureRuntime 拿到 —— 两个 store 的唯一耦合点。
 *
 * UI 层禁止直触 @/infra/**（ESLint D4）：本 store 是 infra/knowledge 端口、
 * infra/db 沉淀仓储与 orchestrator harvester 的**唯一 UI 消费面**。
 */
import { computed, ref } from 'vue'
import { defineStore } from 'pinia'

import { platform } from '@/api'
import { knowledgePort, type KnowledgeDoc, type KnowledgeDocSource } from '@/infra/knowledge'
import { sediment } from '@/infra/db'
import type { KnowledgeDraft, SedimentLog } from '@/infra/db/sediment-ports'
import type { KnowledgeHarvester, SedimentRoundReport } from '@/orchestrator/knowledge-harvester'
import { useWelinkStore } from './index'

/** 待评审列表一次拉取条数（评审队列是工作集，量级小） */
const DRAFT_PAGE_LIMIT = 50
/** 最近提取留痕展示条数 */
const LOG_LIMIT = 20

export const useKnowledgeStore = defineStore('welinkKnowledge', () => {
  const welinkStore = useWelinkStore()

  // ---------------- 状态 ----------------
  const docs = ref<KnowledgeDoc[]>([])
  const docsLoaded = ref(false)
  const drafts = ref<KnowledgeDraft[]>([])
  const logs = ref<SedimentLog[]>([])
  const lastReport = ref<SedimentRoundReport | null>(null)
  const busy = ref(false)
  const draftCount = computed(() => drafts.value.length)
  /** 文件通道可用性（web 调试模式整体降级的判据） */
  const fsAvailable = computed(() => platform === 'tauri')

  async function ensureHarvester(): Promise<KnowledgeHarvester> {
    const runtime = await welinkStore.ensureRuntime()
    return runtime.harvester
  }

  // ---------------- 知识库（清单与文档） ----------------

  async function loadDocs() {
    docs.value = await knowledgePort().listDocs()
    docsLoaded.value = true
  }

  /** 新建/覆盖保存（UI 已做同名与文件名收敛校验） */
  async function saveDoc(input: {
    file: string
    title: string
    content: string
    source: KnowledgeDocSource
    overwrite?: boolean
  }) {
    const entry = await knowledgePort().saveDoc(input)
    await loadDocs()
    return entry
  }

  /** 读文档正文（编辑入口）；文件不存在返回 null（「文件已被移走」提示的数据源） */
  async function readDoc(file: string) {
    return knowledgePort().readDoc(file)
  }

  async function offShelf(file: string) {
    const removed = await knowledgePort().offShelf(file)
    await loadDocs()
    return removed
  }

  async function registerDoc(input: { file: string; title: string }) {
    const entry = await knowledgePort().registerDoc(input)
    await loadDocs()
    return entry
  }

  // ---------------- 待评审队列（评审闸） ----------------

  async function loadDrafts() {
    drafts.value = await sediment().listDrafts({ status: 'pending', limit: DRAFT_PAGE_LIMIT, offset: 0 })
  }

  /** 评审通过：harvester 收口（写知识库 → 置 approved）；成功后刷新清单与队列 */
  async function approveDraft(pk: number, patch: { title: string; content: string }, target?: { file?: string }) {
    const harvester = await ensureHarvester()
    const ok = await harvester.approve(pk, patch, target)
    if (ok) {
      await Promise.all([loadDrafts(), loadDocs()])
    }
    return ok
  }

  async function rejectDraft(pk: number, note: string) {
    const harvester = await ensureHarvester()
    const ok = await harvester.reject(pk, note)
    if (ok) await loadDrafts()
    return ok
  }

  // ---------------- 沉淀执行 ----------------

  /** 立即提取一轮（与自动调度共用 single-flight） */
  async function runOnce() {
    if (busy.value) return null
    busy.value = true
    try {
      const harvester = await ensureHarvester()
      lastReport.value = await harvester.runOnce()
      await Promise.all([loadDrafts(), loadDocs(), loadLogs()])
      return lastReport.value
    } finally {
      busy.value = false
    }
  }

  async function loadLogs() {
    logs.value = await sediment().listSedimentLogs(LOG_LIMIT)
  }

  return {
    docs,
    docsLoaded,
    drafts,
    draftCount,
    logs,
    lastReport,
    busy,
    fsAvailable,
    loadDocs,
    readDoc,
    saveDoc,
    offShelf,
    registerDoc,
    loadDrafts,
    approveDraft,
    rejectDraft,
    runOnce,
    loadLogs,
  }
})
