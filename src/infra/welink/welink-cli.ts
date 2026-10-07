/**
 * 真实 CLI 适配器（设计 §3.3）：把 `WelinkPort` 落到 welink-cli 子进程上。
 *
 * 本文件是「真实对接」的唯一改动面之一（另一个是 `commands.ts`）。业务层对此
 * 一无所知 —— 它只看到 `WelinkPort` 三个方法。
 *
 * 契约细节：
 *  * 传输故障（进程起不来/超时）→ `WelinkError('transport')`，值得重试 1 次；
 *  * 输出结构不符 → `WelinkError('parse')`，重试无意义；
 *  * 命令返回非 0 → 归为 `parse`（CLI 自己报错，多数是参数/环境问题）。
 *
 * [CLI-ASSUME] 两个本侧约定，对接时核对：pull 无回传游标时的兜底格式 `ts:<时间>`；
 * MAX_BATCH=200 的批上限（真实 CLI 若有自己的上限，以两者较小值为准）。
 *
 * [CLI-ASSUME] 群公告能力（`pullAnnouncements`）**暂不实现**：welink-cli 是否有公告
 * 子命令未核实（knowledge-sedimentation K-C 打桩先行），调用侧以
 * `'pullAnnouncements' in port` 判定并诚实降级；对接期按
 * `docs/cli-integration-adaptation-2026-10-04.md` SOP 核实后在此实现。
 */
import type { WelinkConversation, WelinkConvType } from '@/types/welink'
import { nowStamp } from '@/utils/time'
import { parseListOutput, parsePullOutput, parseSendOutput } from './adapter'
import { listArgs, pullArgs, sendArgs } from './commands'
import { runForOutput, withTransportRetry } from './exec'
import { WelinkError, type PullResult, type WelinkPort } from './port'

export interface CliWelinkOptions {
  /** 已解析的可执行文件路径（主干名必须是 welink-cli，Rust 侧白名单校验） */
  cliPath: string
  /** 当前用户工号：判定 @我、过滤自发消息 */
  myUserId: string
  /** 子命令超时预算（毫秒）；轮询场景应显著小于 Rust 默认的 15s */
  timeoutMs?: number
}

/** 每批拉取的硬上限：即使配置被改大也不超过它（P8 载荷可控） */
const MAX_BATCH = 200

export function createCliWelinkPort(options: CliWelinkOptions): WelinkPort {
  const timeoutMs = options.timeoutMs ?? 12_000
  const program = options.cliPath || 'welink-cli'

  return {
    async listConversations(): Promise<WelinkConversation[]> {
      const stdout = await withTransportRetry(() => runForOutput(program, listArgs(), { timeoutMs }))
      return parseListOutput(stdout)
    },

    async pull(conv, after, limit): Promise<PullResult> {
      const batch = Math.min(Math.max(1, limit), MAX_BATCH)
      const args = pullArgs(conv.convId, conv.convType, after, batch)
      const stdout = await withTransportRetry(() => runForOutput(program, args, { timeoutMs }))
      const parsed = parsePullOutput(stdout, {
        myUserId: options.myUserId,
        convId: conv.convId,
        convType: conv.convType,
      })
      // [CLI-ASSUME] CLI 没有回游标时用最后一条消息的时间/UID 兜底：宁可少拉也不要重复拉全量
      const fallbackCursor = parsed.messages.length
        ? `ts:${parsed.messages[parsed.messages.length - 1]?.sentAt ?? nowStamp()}`
        : after
      return { ...parsed, cursor: parsed.cursor || fallbackCursor }
    },

    async send(target: { convId: string; convType: WelinkConvType }, text: string) {
      // 发送**不做传输层重试**：重试可能真的发两次（防滥发是底线），
      // 失败交由外发 worker 的退避 + 回执核对处理（§6.2）。
      const stdout = await runForOutput(program, sendArgs(target, text), { timeoutMs })
      const seed = `${target.convId}-${text.length}-${Date.now()}`
      const msgUid = parseSendOutput(stdout, seed)
      if (!msgUid) throw new WelinkError('发送成功但未取得回执 ID', 'parse')
      return { msgUid }
    },
  }
}
