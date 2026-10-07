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
import type { SafetyGate } from './safety-gate'

/** 建群输入校验：返回问题清单（空串/空清单），UI 提交前与测试共用同一口径 */
export function validateGroupDraft(draft: { groupName: string; members: string[] }): string[] {
  const problems: string[] = []
  if (!draft.groupName.trim()) problems.push('请填写群名称')
  if (draft.groupName.trim().length > 64) problems.push('群名称不能超过 64 字')
  if (!draft.members.length) problems.push('请至少添加一名群成员')
  return problems
}

/** 成员数上限：防「一个 argv 塞几 MB」的畸形调用（Rust 侧 cli_run 与 CreateProcess 都会拒绝） */
const MAX_GROUP_MEMBERS = 500

/** 成员条目长度上限（工号/账号形态，200 字足够） */
const MAX_MEMBER_LEN = 200

/**
 * 建群输入校验的第二段：成员清单的**规模与格式**（与 `validateGroupDraft` 分开是因为
 * 校验时机不同 —— 那份在 UI 提交前即时反馈，这份在真正外呼前的最后一道闸）。
 *
 * 为什么必须查：成员会被 `join(',')` 拼成**单个** `--members` 参数，
 * 1 万个成员会产生几 MB 的一个 argv 条目，OS 直接拒绝（`E2BIG`），
 * 且 Rust 侧的白名单校验会给出难以理解的错误。宁可提前拦下并说人话。
 */
export function validateGroupMembers(members: string[]): string[] {
  const problems: string[] = []
  if (members.length > MAX_GROUP_MEMBERS) {
    problems.push(`群成员不能超过 ${MAX_GROUP_MEMBERS} 人（当前 ${members.length}）`)
  }
  const blank = members.filter((m) => !m.trim())
  if (blank.length) problems.push('成员列表含空项')
  const tooLong = members.filter((m) => m.trim().length > MAX_MEMBER_LEN)
  if (tooLong.length) problems.push(`成员标识不能超过 ${MAX_MEMBER_LEN} 字`)
  // 逗号是 --members 的分隔符，成员里含逗号会被静默拆成两个人（拉错人）
  const withComma = members.filter((m) => m.includes(','))
  if (withComma.length) problems.push('成员标识不能含英文逗号（它用于分隔多人）')
  const trimmed = members.map((m) => m.trim())
  if (new Set(trimmed).size !== trimmed.length) problems.push('成员列表含重复项')
  return problems
}

export interface GroupCreationDeps {
  repo: GroupRepository
  port: GroupPort
  /**
   * 安全闸（S-02）。**必填**：建群是第二条真实外发路径（拉真人进群），
   * 与消息外发同质却一度完全不受 Gate 约束 —— 无急停、无静默时段、无熔断、无频率限制，
   * 「一键全停」也封不住它。不传则等于关掉这道闸，故设为必填（编译期保证）。
   */
  gate: Pick<SafetyGate, 'checkGroupAction' | 'onGroupCreated'>
}

/**
 * 闸门不通过时抛出：这是一次**根本没发生外呼**的拒绝，与业务失败（failed）语义不同
 * —— 后者已留下pending 留痕可查，前者不留（没有任何对外动作发生，不该污染历史）。
 */
export class GroupGateError extends Error {
  constructor(
    message: string,
    /** Gate 的原始判定，便于 UI 区分「可自动恢复的挂起」与「终态拦截」 */
    readonly decision: { action: string; reason: string; detail: string; terminal?: boolean },
  ) {
    super(message)
    this.name = 'GroupGateError'
  }
}

/**
 * 执行一次建群：闸门 → 留痕 → 外呼 → 终态回写，返回终态后的任务记录。
 *
 * 四个细节：
 *  * **闸门在最前**：不通过就不留痕、不外呼（闸门拦的是「意图」，不是「执行」）；
 *  * 留痕失败直接抛（审计凭据写不进去就不该外呼 —— 这是铁律本身，不降级）；
 *  * 外呼**不做传输层重试**（端口层职责，见 `GroupPort` 注释），失败落 failed；
 *  * 终态回写带 `WHERE status='pending'` 原子守卫（repo 层），本函数只负责把
 *    「回写是否成功」如实转告调用方（被人抢写时返回 false，UI 不谎报成功）。
 */
export async function runGroupCreation(
  deps: GroupCreationDeps,
  draft: GroupJobDraft,
): Promise<{ job: GroupJob; finalized: boolean }> {
  // 0. 闸门：急停/熔断/静默/节流/小时上限都在这里判定
  const verdict = deps.gate.checkGroupAction({ groupName: draft.groupName })
  if (verdict.action !== 'send') {
    throw new GroupGateError(verdict.detail, verdict)
  }
  // 成员规模校验放在闸门之后、留痕之前：闸门放行才值得为这次调用留凭据
  const memberProblems = validateGroupMembers(draft.members)
  if (memberProblems.length) {
    throw new GroupGateError(memberProblems.join('；'), {
      action: 'skip',
      reason: 'invalid_members',
      detail: memberProblems.join('；'),
    })
  }

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

  // 3. 成功终态：回写可能被启动清扫抢写（理论边界），finalized=false 时如实上报。
  // 配额在**成功后**才扣 —— 与消息侧 `onSent` 同一原则，失败不白吃配额。
  deps.gate.onGroupCreated()
  const finalized = await deps.repo.completeJob(pending.pk, groupId)
  return {
    job: { ...pending, status: 'success', groupId, error: '', finishedAt: nowStamp() },
    finalized,
  }
}
