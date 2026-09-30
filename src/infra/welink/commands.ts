/**
 * welink-cli 子命令定义（设计 §3.3：**唯一需要随真实接口改动的地方**）。
 *
 * 现状：真实 CLI 文档未到手，这里的子命令名/参数格式是**假设接口**，
 * 依据是「exe 命令行、可拉群/私聊消息、可发消息」这一最小信息。
 * 对接真实 CLI 时改本文件即可，`adapter.ts` 只负责解析输出形状。
 *
 * 统一约定（假设）：
 *   welink-cli list --json                        → 会话候选清单
 *   welink-cli pull --conv <id> --type <t> \
 *              --after <cursor> --limit <n> --json → 增量消息
 *   welink-cli send --conv <id> --type <t> --text <t> --json → 发送回执
 *
 * 所有子命令都要求 `--json`：文本格式解析脆弱，JSON 至少能报出「结构不符」。
 */
import type { WelinkConvType } from '@/types/welink'

/** 子命令名集中定义：对接真实 CLI 时只改这里 */
export const SUBCOMMANDS = {
  list: 'list',
  pull: 'pull',
  send: 'send',
  /** 快速建群（migration v3）：welink-cli create-group --name <群名> --members <id1,id2,…> */
  createGroup: 'create-group',
  version: '--version',
} as const

/** `list` 参数 */
export function listArgs(): string[] {
  return [SUBCOMMANDS.list, '--json']
}

/** `pull` 参数 */
export function pullArgs(convId: string, convType: WelinkConvType, after: string, limit: number): string[] {
  const args = [SUBCOMMANDS.pull, '--conv', convId, '--type', convType, '--limit', String(limit), '--json']
  // after 为空串时不传该参数：首次拉取应取「最新一批」，而不是「从纪元开始」
  if (after) args.push('--after', after)
  return args
}

/**
 * `send` 参数。
 *
 * 文本经 **参数数组** 传递（不经 shell），所以引号/换行/中文都安全；
 * 但 CLI 自身可能对超长单参数有限制，因此由 S6（maxDraftChars）在外层兜住长度。
 */
export function sendArgs(target: { convId: string; convType: WelinkConvType }, text: string): string[] {
  return [SUBCOMMANDS.send, '--conv', target.convId, '--type', target.convType, '--text', text, '--json']
}

/** `--help` 试跑（Settings 里的「试跑」按钮用） */
export function helpArgs(): string[] {
  return ['--help']
}

/**
 * `create-group` 参数（快速建群，migration v3）。
 *
 * 群名称与成员清单各自作为**独立参数**传递（不经 shell），中文群名/逗号成员串
 * 都安全；成员串用半角逗号连接（归一化入口 `normalizeMemberIds` 已保证无空项）。
 */
export function createGroupArgs(name: string, memberIds: string[]): string[] {
  return [SUBCOMMANDS.createGroup, '--name', name, '--members', memberIds.join(','), '--json']
}
