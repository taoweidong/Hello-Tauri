/**
 * CLI 子进程调用封装（设计 §9）。
 *
 * 职责边界：`exec` 只负责「把命令跑起来、把输出解码出来、把失败归类」，
 * **不认识任何 welink 业务语义** —— 子命令名与参数格式在 `commands.ts`。
 *
 * 四个平台细节（改代码别丢）：
 *  1. 输出经 base64 回传，这里解码（UTF-8 严格 → GBK 兜底，见 `utils/b64.ts`）；
 *  2. 退出码非 0 不算通道故障（CLI 自身报错是常态），由调用方决定如何分类；
 *  3. 超时必须与 Rust 侧一致地报 `transport` 错，否则退避策略会误判为可重试；
 *  4. `timedOut=true` 时输出通常不完整，直接判失败而不尝试解析。
 */
import { bridge } from '@/api'
import type { CliResult } from '@/types'
import { decodeBase64Text } from '@/utils/b64'
import { WelinkError } from './port'

export interface RunOptions {
  /** 超时（毫秒）。Rust 侧默认 15s，这里显式传值以便不同子命令给不同预算 */
  timeoutMs?: number
  /** 失败时是否抛出（默认 true）。list/pull 用 false 走「返回码判定 + 上层分类」 */
  throwOnError?: boolean
}

export interface CommandOutput {
  exitCode: number | null
  stdout: string
  stderr: string
  timedOut: boolean
  stdoutTruncated: boolean
  durationMs: number
}

/** 跑一个命令并解码输出 */
export async function runCommand(program: string, args: string[], options: RunOptions = {}): Promise<CommandOutput> {
  let result: CliResult
  try {
    result = await bridge.cliRun(program, args, options.timeoutMs)
  } catch (error) {
    // 通道故障（白名单拒绝、进程起不来）统一归为 transport，让编排层退避而不是直接失败
    throw new WelinkError(
      error instanceof Error ? error.message : String(error),
      'transport',
      error,
    )
  }

  const stdout = decodeBase64Text(result.stdout)
  const stderr = decodeBase64Text(result.stderr)

  if (result.timedOut) {
    throw new WelinkError(`命令超时（${result.durationMs}ms）：${program} ${args.join(' ')}`, 'transport')
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

/** 跑命令并要求成功输出（解析前使用；失败按 `parse` 归类，重试无意义） */
export async function runForOutput(program: string, args: string[], options: RunOptions = {}): Promise<string> {
  const output = await runCommand(program, args, options)
  if (output.exitCode !== 0) {
    const detail = output.stderr.trim() || output.stdout.trim() || '无输出'
    throw new WelinkError(`命令返回码 ${output.exitCode}：${args.join(' ')} :: ${detail}`, 'parse')
  }
  return output.stdout
}

/**
 * 传输层重试：仅对 `transport` 错重试 1 次（设计 §6.1「infra 内部已重试1次」）。
 *
 * 为什么只重 1 次：CLI 冷启动本身就有成本（O2），重试太多会把轮询周期撑爆；
 * 而真正的持续故障应由退避策略（5/10/20/40/60s）处理，不是在这一层死磕。
 */
export async function withTransportRetry<T>(task: () => Promise<T>, retries = 1): Promise<T> {
  let lastError: unknown
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await task()
    } catch (error) {
      lastError = error
      const kind = error instanceof WelinkError ? error.kind : 'unknown'
      if (kind !== 'transport' || attempt === retries) throw error
    }
  }
  throw lastError
}