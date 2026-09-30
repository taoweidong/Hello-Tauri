/**
 * 快速建群 store（migration v3）—— UI 与「数据层 + 编排层」之间唯一的状态层。
 *
 * 职责边界（与 welink store 同一立场，但链路简单得多）：
 *  * **动作即映射**：模板 CRUD、历史查询、发起建群都只是薄转发，真正的规则
 *    （先留痕后外呼、终态原子回写）在编排层与数据层，这里不做二次实现；
 *  * **聚合口径唯一**：`creating`（外呼进行中）、`templatesLoaded`（区分「没装载」
 *    与「装载过但为空」，D-6：提示若不可信比不提示更坏）只在这里维护；
 *  * **跨 Tab 同步走版本号**：建群/删历史后自增 `historyVersion`，历史 Tab 监听
 *    它重载当前页 —— 避免两个组件互持引用。
 */
import { defineStore } from 'pinia'
import { ref } from 'vue'

import { dbMigrateAll, group } from '@/infra/db'
import type { GroupJobQuery } from '@/infra/db/group-ports'
import { TEMPLATE_HARD_LIMIT } from '@/infra/db/group-ports'
import { groupClient } from '@/infra/welink'
import type { GroupJob, GroupJobDraft, GroupTemplate, GroupTemplateDraft } from '@/types/welink'
import { normalizeWelinkSettings } from '@/types/welink'
import { logger } from '@/utils/logger'
import { runGroupCreation, validateGroupDraft } from '@/orchestrator/group'
import { useAppStore } from '@/stores/app'

export const useGroupStore = defineStore('group', () => {
  // ---------------- 状态 ----------------
  const templates = ref<GroupTemplate[]>([])
  /** 模板清单是否已装载过（与 welink store 的 conversationsLoaded 同理由） */
  const templatesLoaded = ref(false)
  /** 建群外呼进行中（同一次只允许一个 —— CLI 侧无并发保证） */
  const creating = ref(false)
  /** 历史「版本号」：建群/删记录后自增，历史 Tab 监听重载 */
  const historyVersion = ref(0)

  let initialized = false

  // ---------------- 生命周期 ----------------

  /** 表结构就绪（幂等；与 welink store 的 ensureSchema 同理由：页面先于总开关可达） */
  async function ensureSchema() {
    try {
      await dbMigrateAll()
      return true
    } catch (error) {
      logger.error('建群表结构初始化失败', error)
      return false
    }
  }

  /**
   * 装载（GroupView 挂载时调用，进程内幂等）：
   * 迁移 → 启动清扫（上一会话遗留的 pending 标记 interrupted）→ 装模板。
   * 历史清单由历史 Tab 自管（带筛选与分页），这里不抢。
   */
  async function init(): Promise<boolean> {
    if (initialized) return true
    initialized = true
    const ok = await ensureSchema()
    if (!ok) return false
    try {
      const swept = await group().markInterrupted()
      if (swept) logger.warn(`建群历史：${swept} 条中断留痕已标记为「结果未知」`)
    } catch (error) {
      logger.error('建群中断留痕清扫失败', error)
    }
    await loadTemplates()
    return true
  }

  // ---------------- 模板 CRUD ----------------

  async function loadTemplates() {
    try {
      const rows = await group().listTemplates(TEMPLATE_HARD_LIMIT)
      templates.value = rows
      if (rows.length >= TEMPLATE_HARD_LIMIT) {
        logger.warn(`建群模板已达硬上限 ${TEMPLATE_HARD_LIMIT}，更早的模板未显示`)
      }
    } catch (error) {
      logger.error('装载建群模板失败', error)
    } finally {
      templatesLoaded.value = true
    }
  }

  /** 新建或更新模板（pk 为空 = 新建）；成功后重载清单 */
  async function saveTemplate(draft: GroupTemplateDraft, pk?: number): Promise<void> {
    const repo = group()
    if (pk === undefined) {
      await repo.createTemplate(draft)
      logger.info(`已创建建群模板「${draft.name}」（${draft.members.length} 名成员）`)
    } else {
      const changed = await repo.updateTemplate(pk, draft)
      if (!changed) throw new Error(`模板不存在或已被删除：#${pk}`)
      logger.info(`已更新建群模板「${draft.name}」`)
    }
    await loadTemplates()
  }

  async function removeTemplate(pk: number): Promise<void> {
    const changed = await group().removeTemplate(pk)
    if (!changed) throw new Error(`模板不存在或已被删除：#${pk}`)
    await loadTemplates()
  }

  // ---------------- 建群历史 ----------------

  /** 历史查询直通（筛选与分页由历史 Tab 持有，store 不复制状态） */
  async function listJobs(query: GroupJobQuery): Promise<GroupJob[]> {
    return group().listJobs(query)
  }

  async function countJobs(query: Omit<GroupJobQuery, 'limit' | 'offset'>): Promise<number> {
    return group().countJobs(query)
  }

  async function removeJob(pk: number): Promise<void> {
    const changed = await group().removeJob(pk)
    if (!changed) throw new Error(`历史记录不存在或已被删除：#${pk}`)
    historyVersion.value += 1
  }

  // ---------------- 建群动作 ----------------

  /**
   * 发起建群：校验 → 编排（留痕 → 外呼 → 终态）→ 通知历史重载。
   *
   * 数据源与消息链路同源（`welinkSource` + `cliPath`）：浏览器调试模式天然 mock，
   * 桌面模式选了真实 CLI 才走真进程。返回终态任务（status/groupId/error 已就位），
   * 由 UI 决定成功提示与失败引导。
   */
  async function createGroup(draft: GroupJobDraft): Promise<GroupJob> {
    const problems = validateGroupDraft({ groupName: draft.groupName, members: draft.members })
    if (problems.length) throw new Error(problems.join('；'))

    creating.value = true
    try {
      const settings = normalizeWelinkSettings(useAppStore().settings.weLink)
      const { job, finalized } = await runGroupCreation({ repo: group(), port: groupClient({ settings }) }, draft)
      if (job.status === 'success' && !finalized) {
        logger.warn(`建群 #${job.pk} 外呼成功但终态回写被抢（疑似与启动清扫并发），历史以库内状态为准`)
      }
      if (job.status === 'failed') {
        logger.error(`建群「${job.groupName}」失败：${job.error}`)
      } else {
        logger.info(`建群「${job.groupName}」完成：${job.groupId}（${job.members.length} 名成员）`)
      }
      historyVersion.value += 1
      return job
    } finally {
      creating.value = false
    }
  }

  return {
    templates,
    templatesLoaded,
    creating,
    historyVersion,
    init,
    loadTemplates,
    saveTemplate,
    removeTemplate,
    listJobs,
    countJobs,
    removeJob,
    createGroup,
  }
})
