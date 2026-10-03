/**
 * CLI 子进程调用封装（与 `infra/welink/exec.ts` 同构，错误类型换成 CodeHubError）。
 *
 * 职责边界：`exec` 只负责「把命令跑起来、把输出解码出来、把失败归类」，
 * **不认识任何 codehub 业务语义** —— 子命令名与参数格式在 `codehub-cli.ts`。
 *
 * token 脱敏硬约束（design D6）：token 以命令行参数注入（用户决策），任何错误
 * 信息、诊断串都不得携带 token 明文 —— `redactToken` 对 `--token` 的值做遮蔽。
 */
import { bridge } from '@/api'
import type { CliResult } from '@/types'
import { decodeBase64Text } from '@/utils/b64'
import { CodeHubError } from './port'

export interface RunOptions {
  /** 超时（毫秒）。Rust 侧默认 15s，这里显式传值以便不同子命令给不同预算 */
  timeoutMs?: number
}

export interface CommandOutput {
  exitCode: number | null
  stdout: string
  stderr: string
  timedOut: boolean
  stdoutTruncated: boolean
  durationMs: number
}

/** [CLI-ASSUME] token 以 `--token <值>` 全局参数注入（用户已确认参数方式；参数名待核实） */
export const TOKEN_FLAG = '--token'

/** 错误信息脱敏：`--token` 的值原样拼进错误串会随 last_error 与日志扩散，只保留长度 */
export function redactToken(args: string[]): string {
  const out: string[] = []
  let redactNext = false
  for (const arg of args) {
    if (redactNext) {
      out.push(`[token 已省略 ${arg.length} 字]`)
      redactNext = false
      continue
    }
    out.push(arg)
    if (arg === TOKEN_FLAG) redactNext = true
  }
  return out.join(' ')
}

/** [CLI-ASSUME] 认证失败的特征串（对接真实 CLI 后按其错误文案核实补充） */
const AUTH_PATTERN = /auth|token|unauthorized|401|403|credential|login|permission/i

/** 跑一个命令并解码输出；超时与通道故障归 transport */
export async function runCommand(program: string, args: string[], options: RunOptions = {}): Promise<CommandOutput> {
  let result: CliResult
  try {
    result = await bridge.cliRun(program, args, options.timeoutMs)
  } catch (error) {
    // 通道故障（白名单拒绝、进程起不来）统一归为 transport，让编排层退避而不是直接失败
    throw new CodeHubError(error instanceof Error ? error.message : String(error), 'transport', error)
  }

  const stdout = decodeBase64Text(result.stdout)
  const stderr = decodeBase64Text(result.stderr)

  if (result.timedOut) {
    throw new CodeHubError(`命令超时（${result.durationMs}ms）：${program} ${redactToken(args)}`, 'transport')
  }

  return {
    exitCode: result.exitCode,
    stdout: stdout.text,
    stderr: stderr.text,
    timedOut: result.timedOut,
    stdoutTruncated: result.stdoutTruncated,
    durationMs: result.durationMs,
  }
}

/**
 * 跑命令并要求成功输出。失败分类：
 *  * 认证特征 → `auth`（重试无意义，应引导用户改配置）；
 *  * 其余非 0 退出 → `parse`（CLI 自己报错，多数是参数/环境问题）。
 */
export async function runForOutput(
  program: string,
  args: string[],
  options: RunOptions = {},
): Promise<{ text: string; stdoutTruncated: boolean }> {
  const output = await runCommand(program, args, options)
  if (output.exitCode !== 0) {
    const detail = output.stderr.trim() || output.stdout.trim() || '无输出'
    const kind = AUTH_PATTERN.test(detail) ? 'auth' : 'parse'
    throw new CodeHubError(`命令返回码 ${output.exitCode}：${redactToken(args)} :: ${detail}`, kind)
  }
  return { text: output.stdout, stdoutTruncated: output.stdoutTruncated }
}

/**
 * 传输层重试：仅对 `transport` 错重试 1 次（与 welink 同款理由：CLI 冷启动有成本，
 * 重试太多会撑爆同步周期；真正的持续故障由编排层退避处理，不在这层死磕）。
 */
export async function withTransportRetry<T>(task: () => Promise<T>): Promise<T> {
  let lastError: unknown
  for (let attempt = 0; attempt <= 1; attempt += 1) {
    try {
      return await task()
    } catch (error) {
      lastError = error
      const kind = error instanceof CodeHubError ? error.kind : 'unknown'
      if (kind !== 'transport' || attempt === 1) throw error
    }
  }
  throw lastError
}
