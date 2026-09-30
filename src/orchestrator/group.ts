/**
 * 快速建群编排（migration v3）—— 建群版「先落库再外呼」铁律。
 *
 * WeLink 自动回复的要点3 是「草稿先落库置 ready 才允许外发」；建群是同类的对外
 * 动作（拉真人进群），套同一规则：外呼 CLI **之前**必须先落一条 pending 留痕，
 * 外呼结束后把**同一条**记录落成终态。收益是审计与崩溃安全：
 *
 *  * 进程在 CLI 调用中途死掉 → 留下「何时、用哪个模板、拉了谁」的凭据，
 *    下次启动由 `markInterrupted` 清扫成 interrupted（结果未知），而不是凭空消失；
 *  * CLI 成功但回写前崩溃 → 历史里至少有 pending 可查，不会被记成失败误导重试。
 *
 * 本模块只依赖端口接口（repo + port 由调用方注入），编排逻辑可脱离 Vue/bridge 单测。
 */
import type { GroupJob, GroupJobDraft } from '@/types/welink'
import type { GroupRepository } from '@/infra/db/group-ports'
import type { GroupPort } from '@/infra/welink/port'
import { nowStamp } from '@/utils/time'

/** 建群输入校验：返回问题清单（空串/空清单），UI 提交前与测试共用同一口径 */
export function validateGroupDraft(draft: { groupName: string; members: string[] }): string[] {
  const problems: string[] = []
  if (!draft.groupName.trim()) problems.push('请填写群名称')
  if (draft.groupName.trim().length > 64) problems.push('群名称不能超过 64 字')
  if (!draft.members.length) problems.push('请至少添加一名群成员')
  return problems
}

export interface GroupCreationDeps {
  repo: GroupRepository
  port: GroupPort
}

/**
 * 执行一次建群：留痕 → 外呼 → 终态回写，返回终态后的任务记录。
 *
 * 三个细节：
 *  * 留痕失败直接抛（审计凭据写不进去就不该外呼 —— 这是铁律本身，不降级）；
 *  * 外呼**不做传输层重试**（端口层职责，见 `GroupPort` 注释），失败落 failed；
 *  * 终态回写带 `WHERE status='pending'` 原子守卫（repo 层），本函数只负责把
 *    「回写是否成功」如实转告调用方（被人抢写时返回 false，UI 不谎报成功）。
 */
export async function runGroupCreation(
  deps: GroupCreationDeps,
  draft: GroupJobDraft,
): Promise<{ job: GroupJob; finalized: boolean }> {
  // 1. 先留痕：pending 记录是对外动作的唯一许可凭据
  const pending = await deps.repo.createJob(draft)

  // 2. 外呼：失败就地落 failed（错误全文进留痕，供历史页排查）
  let groupId: string
  try {
    const result = await deps.port.createGroup({ name: draft.groupName, memberIds: draft.members })
    groupId = result.groupId
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const finalized = await deps.repo.failJob(pending.pk, message)
    return { job: { ...pending, status: 'failed', error: message, finishedAt: nowStamp() }, finalized }
  }

  // 3. 成功终态：回写可能被启动清扫抢写（理论边界），finalized=false 时如实上报
  const finalized = await deps.repo.completeJob(pending.pk, groupId)
  return {
    job: { ...pending, status: 'success', groupId, error: '', finishedAt: nowStamp() },
    finalized,
  }
}
