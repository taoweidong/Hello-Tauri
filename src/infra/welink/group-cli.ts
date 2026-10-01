/**
 * 建群端口的真实 CLI 适配器（migration v3）。
 *
 * 复用消息链路的 `exec` 通道（白名单、base64 解码、错误分类），唯独**不做传输层
 * 重试**：`list`/`pull` 是幂等读，抖动重试 1 次无损；`create-group` 不是 ——
 * CLI 可能已经把群建成只是响应丢失，盲目重试会拉出两个同名的群。失败就地抛出，
 * 由编排层落 failed 留痕，是否再建由人决定。
 *
 * [CLI-ASSUME] 对接时核对：create-group 的退出码语义、是否总能回传群 ID（回传缺失时
 * adapter 会派生 `local-` 占位群 ID，UI 据此提示人工核对，见 adapter.ts）。
 */
import { createGroupArgs } from './commands'
import { runForOutput } from './exec'
import { WelinkError, type GroupPort } from './port'
import { parseCreateGroupOutput } from './adapter'

export interface CliGroupOptions {
  /** 已解析的可执行文件路径（主干名必须是 welink-cli，Rust 侧白名单校验） */
  cliPath: string
  /** 子命令超时预算（毫秒）；建群涉及成员拉入，默认放行到 Rust 侧 15s 兜底 */
  timeoutMs?: number
}

export function createCliGroupPort(options: CliGroupOptions): GroupPort {
  const program = options.cliPath || 'welink-cli'
  const timeoutMs = options.timeoutMs

  return {
    async createGroup({ name, memberIds }) {
      let stdout: string
      try {
        stdout = await runForOutput(program, createGroupArgs(name, memberIds), { timeoutMs })
      } catch (error) {
        // runForOutput 抛的已是分类好的 WelinkError（transport/parse），原样上抛；
        // 非 WelinkError 的意外异常统一归 transport（通道层问题，不是协议不兼容）
        if (error instanceof WelinkError) throw error
        throw new WelinkError(error instanceof Error ? error.message : String(error), 'transport', error)
      }
      const seed = `${name}-${memberIds.length}-${Date.now()}`
      return { groupId: parseCreateGroupOutput(stdout, seed) }
    },
  }
}
