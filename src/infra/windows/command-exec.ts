/**
 * 命令执行适配器（design D1：注册表闸在此生效）。
 *
 * 执行链：校验登记 → 组装参数（固定参数 + 限额内追加参数，按字面）→
 * bridge.cliRun → base64 解码（UTF-8 严格 → GBK 兜底）→ 结果结构。
 *
 * 错误契约与 cliRun 对齐（Bridge types.ts 注释）：
 *  * 未登记 ID / 追加参数超限 = 通道故障 → reject（不触碰 Bridge）；
 *  * 白名单拒绝、进程起不来 = Bridge reject 透传；
 *  * 退出码非 0 / 命令超时 = **正常返回**结果对象（timedOut/exitCode 表达）。
 */
import { bridge } from '@/api'
import type { CliResult } from '@/types'
import { decodeBase64Text } from '@/utils/b64'
import type { CommandExecOutcome } from './port'
import { getRegisteredCommand } from './registry'

/** cliRun 依赖形状（测试注入桩用） */
export type CliRunFn = (program: string, args: string[], timeoutMs?: number) => Promise<CliResult>

/** 把 cli_run 的 base64 回传解码为文本结果 */
function toOutcome(result: CliResult): CommandExecOutcome {
  return {
    exitCode: result.exitCode,
    stdout: decodeBase64Text(result.stdout).text,
    stderr: decodeBase64Text(result.stderr).text,
    stdoutTruncated: result.stdoutTruncated,
    stderrTruncated: result.stderrTruncated,
    timedOut: result.timedOut,
    durationMs: result.durationMs,
  }
}

/** 组装一次登记命令的执行器 */
export function createCommandRunner(cliRun: CliRunFn = (...args) => bridge.cliRun(...args)) {
  return async function runCommand(commandId: string, extraArgs: string[] = []): Promise<CommandExecOutcome> {
    const entry = getRegisteredCommand(commandId)
    if (!entry) {
      throw new Error(`命令未登记：${commandId}（只允许执行 registry.ts 登记过的命令）`)
    }
    if (extraArgs.length > entry.extraArgs) {
      throw new Error(`命令 ${commandId} 只允许追加 ${entry.extraArgs} 个参数，收到 ${extraArgs.length} 个`)
    }
    const result = await cliRun(entry.program, [...entry.args, ...extraArgs], entry.timeoutMs)
    return toOutcome(result)
  }
}
