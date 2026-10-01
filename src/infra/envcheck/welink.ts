/**
 * WeLink CLI 环境探测器（环境检测页的第一注册项）。
 *
 * 两步检测，逐步给出结论（步骤结果独立呈现，坏在哪一步一目了然）：
 *  1. **可执行检查** `welink-cli --version`：判定 exe 能否启动、能否正常退出 ——
 *     这一步失败（启动失败/超时/非 0 退出）则后续步骤没有意义，直接短路；
 *  2. **环境自检** `welink-cli doctor --json` [CLI-ASSUME]：假设 CLI 提供自检子命令
 *     （登录态/网络等）。这一步**允许缺席**：非 0 退出或输出不符都降级为 warn，
 *     不影响「CLI 基本可用」的结论 —— 自检命令是增强信息，不是可用性的前提。
 *
 * 复用消息链路的 `exec` 通道（白名单/base64 解码/错误分类），但**不走
 * `withTransportRetry`**：环境检测是诊断行为，对结果要求「快而真」，抖动重试
 * 只会把检测时长翻倍，失败本身就是有效结论（用户重跑即可）。
 */
import { doctorArgs } from '@/infra/welink/commands'
import { runCommand } from '@/infra/welink/exec'
import { WelinkError } from '@/infra/welink/port'
import { parseJson } from '@/infra/welink/adapter'
import type { EnvCheckItem, EnvCheckOutcome, EnvCheckStatus, EnvCheckStep } from './port'
import { worstStatus } from './port'

/** 探测器 ID（store 合并状态的主键；改名等于换检测项） */
export const WELINK_CHECK_ID = 'welink-cli'

/** 单次 CLI 调用的超时预算：必须小于工厂层的硬超时（见 index.ts），留出两次调用的余量 */
const VERSION_TIMEOUT_MS = 5_000
const DOCTOR_TIMEOUT_MS = 8_000

/** exec 层超时错误的消息形态（WelinkError transport）；用它区分「超时」与「起不来」 */
const TIMEOUT_MESSAGE = /命令超时（\d+ms）/

export interface WelinkCheckOptions {
  /**
   * 可执行文件路径。允许为空：空时探测裸命令名 `welink-cli`（探测 PATH），
   * 结论里会注明使用的是哪个路径 —— 「没配置路径也能测出装没装」是有效诊断。
   */
  cliPath?: string
}

/** stderr/stdout 摘录：错误详情只留前 400 字符，防止 CLI 崩溃栈刷爆详情面板 */
function excerpt(text: string, max = 400): string {
  const trimmed = text.trim()
  return trimmed.length > max ? `${trimmed.slice(0, max)}…（已截断）` : trimmed
}

function firstLine(text: string): string {
  return text.trim().split(/\r?\n/, 1)[0]?.trim() ?? ''
}

/** 把 runCommand 的异常翻译成步骤结论（不重抛 —— 探测永不 reject） */
function stepFromError(stepName: string, error: unknown, started: number): EnvCheckStep {
  const durationMs = Date.now() - started
  const message = error instanceof Error ? error.message : String(error)
  const isTimeout = error instanceof WelinkError && TIMEOUT_MESSAGE.test(message)
  if (isTimeout) {
    return { name: stepName, status: 'timeout', summary: `超时（${durationMs}ms）未返回`, durationMs }
  }
  return { name: stepName, status: 'fail', summary: message, durationMs }
}

/** doctor --json 的约定返回形状 [CLI-ASSUME] */
interface DoctorReport {
  ok?: boolean
  problems?: unknown
}

export function createWelinkEnvCheck(options: WelinkCheckOptions = {}): EnvCheckItem {
  // 空路径回落裸命令名：Windows 会按 PATH 搜索，检测「有没有装」正是要利用这一点
  const program = options.cliPath?.trim() || 'welink-cli'

  return {
    id: WELINK_CHECK_ID,
    name: 'WeLink CLI',
    description: `welink-cli 可执行文件与运行环境（${program}）`,
    async run(): Promise<EnvCheckOutcome> {
      const started = Date.now()
      const steps: EnvCheckStep[] = []

      // —— 第 1 步：可执行检查（失败即短路） ——
      const vStarted = Date.now()
      let version = ''
      try {
        const output = await runCommand(program, ['--version'], { timeoutMs: VERSION_TIMEOUT_MS })
        if (output.exitCode !== 0) {
          const detail = excerpt(output.stderr || output.stdout)
          steps.push({
            name: '可执行检查',
            status: 'fail',
            summary: `welink-cli --version 返回码 ${output.exitCode}${detail ? `：${detail}` : ''}`,
            durationMs: Date.now() - vStarted,
          })
        } else {
          // 版本号取首行且限长：CLI 可能在版本后跟多行说明
          version = firstLine(output.stdout).slice(0, 80)
          steps.push({
            name: '可执行检查',
            status: 'ok',
            summary: version ? `可正常执行（${version}）` : '可正常执行（未回传版本号）',
            durationMs: Date.now() - vStarted,
          })
        }
      } catch (error) {
        steps.push(stepFromError('可执行检查', error, vStarted))
      }

      if (steps[0]?.status !== 'ok') {
        // 短路：exe 都跑不起来，doctor 的结果没有解释力。把失败结论带上路径便于排障
        const failed = steps[0]
        return {
          status: worstStatus(steps),
          summary: `${failed?.summary ?? '可执行检查失败'}（使用路径：${program}）`,
          details: `检测路径：${program}\n请到「WeLink 助手 → 监控配置」确认 CLI 路径，或确认 welink-cli 已安装。`,
          steps,
          durationMs: Date.now() - started,
        }
      }

      // —— 第 2 步：环境自检（允许缺席，缺席/异常降级 warn 而不是 fail） ——
      const dStarted = Date.now()
      try {
        const output = await runCommand(program, doctorArgs(), { timeoutMs: DOCTOR_TIMEOUT_MS })
        if (output.exitCode !== 0) {
          steps.push({
            name: '环境自检',
            status: 'warn',
            summary: `自检命令不可用（返回码 ${output.exitCode}），可能为旧版本 CLI —— 基础可用性不受影响`,
            durationMs: Date.now() - dStarted,
          })
        } else {
          // [CLI-ASSUME] 约定形状 { ok: boolean, problems?: string[] }
          const report = parseJson<DoctorReport>(output.stdout, '环境自检')
          const problems = Array.isArray(report.problems)
            ? report.problems.map((item) => String(item)).filter(Boolean)
            : []
          if (report.ok === false) {
            steps.push({
              name: '环境自检',
              status: 'fail',
              summary: problems.length ? problems.join('；') : 'CLI 自检报告异常（未通过且未给出原因）',
              durationMs: Date.now() - dStarted,
            })
          } else {
            steps.push({
              name: '环境自检',
              status: 'ok',
              summary: 'CLI 环境自检通过',
              durationMs: Date.now() - dStarted,
            })
          }
        }
      } catch (error) {
        if (error instanceof WelinkError && error.kind === 'parse') {
          // 输出不是约定 JSON：多为 CLI 无此命令或版本差异，降级 warn（见文件头注释）
          steps.push({
            name: '环境自检',
            status: 'warn',
            summary: `自检输出不符合约定结构（${error.message}）—— 对接真实 CLI 后请核对 doctor 契约`,
            durationMs: Date.now() - dStarted,
          })
        } else {
          steps.push(stepFromError('环境自检', error, dStarted))
        }
      }

      const status: EnvCheckStatus = worstStatus(steps)
      const versionText = version ? `（${version}）` : ''
      const summary =
        status === 'ok'
          ? `welink-cli 可用${versionText}，环境自检通过`
          : status === 'warn'
            ? `welink-cli 可用${versionText}，但环境自检未确认（详见步骤）`
            : status === 'timeout'
              ? '检测超时：CLI 响应过慢，建议检查本机负载'
              : 'welink-cli 环境自检未通过（详见步骤）'

      return {
        status,
        summary,
        steps,
        durationMs: Date.now() - started,
      }
    },
  }
}
