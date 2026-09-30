/**
 * 快速建群的数据层端口契约（与 `ports.ts` 的 WelinkRepository 同构，独立成文）。
 *
 * 两条硬约束与 welink 四表一致，改动时勿破坏：
 *  1. **分页强制**（P7）：列表方法必须带 `limit`，SQL 必含 `LIMIT`；
 *  2. **先留痕后外呼**：建群任务只允许经 `createJob`（pending）进入，终态由
 *     `completeJob` / `failJob` 以 `WHERE status='pending'` 原子落定 —— 并发终写
 *     或启动清扫（pending → interrupted）不得互相覆盖。
 */
import type { GroupJob, GroupJobDraft, GroupJobStatus, GroupTemplate, GroupTemplateDraft } from '@/types/welink'

/** 建群历史分页查询条件 */
export interface GroupJobQuery {
  status?: GroupJobStatus[]
  /** 匹配群名称 / 模板名 / 成员工号（LIKE） */
  keyword?: string
  from?: string
  to?: string
  limit: number
  offset: number
}

/** 模板清单一次读取的硬上限：模板是人工维护的小清单，超出即告警而非静默翻页 */
export const TEMPLATE_HARD_LIMIT = 200

export interface GroupRepository {
  // —— 模板 CRUD ——
  /** 模板清单（按更新时间倒序，分页强制） */
  listTemplates(limit: number): Promise<GroupTemplate[]>
  countTemplates(): Promise<number>
  getTemplate(pk: number): Promise<GroupTemplate | null>
  createTemplate(draft: GroupTemplateDraft): Promise<GroupTemplate>
  updateTemplate(pk: number, draft: GroupTemplateDraft): Promise<boolean>
  removeTemplate(pk: number): Promise<boolean>

  // —— 建群历史（先留痕后外呼） ——
  /** 落一条 pending 留痕（外呼 CLI 之前的唯一入口） */
  createJob(draft: GroupJobDraft): Promise<GroupJob>
  /** 成功终态：`WHERE status='pending'` 原子落定，返回是否由本次调用完成 */
  completeJob(pk: number, groupId: string): Promise<boolean>
  /** 失败终态：同上原子落定 */
  failJob(pk: number, error: string): Promise<boolean>
  /**
   * 启动清扫：上一会话遗留的 pending（进程中断，结局未知）批量标记 interrupted。
   * 只在应用启动时调用一次 —— 运行中的建群不会越过 init 存活到下一次 init。
   */
  markInterrupted(): Promise<number>
  /** 历史分页（P7）+ 筛选 */
  listJobs(query: GroupJobQuery): Promise<GroupJob[]>
  /** 与 `listJobs` 同口径的计数（分页脚） */
  countJobs(query: Omit<GroupJobQuery, 'limit' | 'offset'>): Promise<number>
  /** 删除单条历史记录（只删留痕，不动模板） */
  removeJob(pk: number): Promise<boolean>
}

/** 建群状态文案与色调（UI 与测试共用，避免各处硬编码） */
export const GROUP_JOB_STATUS_LABEL: Record<GroupJobStatus, string> = {
  pending: '创建中',
  success: '已建群',
  failed: '失败',
  interrupted: '结果未知',
}

export const GROUP_JOB_STATUS_TONE: Record<GroupJobStatus, 'info' | 'warning' | 'success' | 'danger' | 'muted'> = {
  pending: 'info',
  success: 'success',
  failed: 'danger',
  interrupted: 'warning',
}
