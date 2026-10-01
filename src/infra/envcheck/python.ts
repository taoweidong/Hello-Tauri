/**
 * Python 环境探测器（环境检测页第二注册项）：检测本机 Python 是否 ≥ 3.10。
 *
 * 探测策略（Windows 实情的候选链）：
 *  * 依次尝试 `python --version`、`py --version`，**首个能报出版本号的命令即胜出**
 *    并短路 —— 候选序反映 Windows 现实：`python` 可能是微软商店的占位 stub
 *    （退出码 9009、无输出），官方安装器带的 `py` 启动器反而更可靠；
 *  * 全部候选都不可用 → fail，结论列出已尝试的命令；任一候选超时 → 整体 timeout
 *    （通道级故障不伪装成「未安装」）。
 *
 * 版本判定：`Python X.Y.Z`（Python 2 把 --version 打到 stderr，故 stdout 失败后
 * 回落 stderr 再解析一次）；**≥ 3.10 满足**（3.10 系列含在内），低于则 fail。
 * 结论里始终带上「用的是哪个命令」—— 排障时能区分「装的哪个 Python」。
 */
import { runCommand } from '@/infra/welink/exec'
import { WelinkError } from '@/infra/welink/port'
import type { EnvCheckItem, EnvCheckOutcome, EnvCheckStep } from './port'
import { worstStatus } from './port'

/** 探测器 ID（store 合并状态的主键；改名等于换检测项） */
export const PYTHON_CHECK_ID = 'python'

/** 版本要求：≥ 3.10（3.10 系列本身满足） */
const MIN_MAJOR = 3
const MIN_MINOR = 10

/** 候选命令链：首个能报出版本的胜出。py 启动器是官方安装器的可靠入口 */
const CANDIDATES = ['python', 'py']

/** 单候选超时预算：--version 是毫秒级操作，5s 已极宽裕；两候选合计 < 工厂硬超时 16s */
const PROBE_TIMEOUT_MS = 5_000

/** exec 层超时错误的消息形态（WelinkError transport）；用它区分「超时」与「起不来」 */
const TIMEOUT_MESSAGE = /命令超时（\d+ms）/

/** 从 `Python X.Y.Z` 输出中解析版本（stdout 与 stderr 都试 —— Python 2 打在 stderr） */
function parseVersion(text: string): { major: number; minor: number; patch: number } | null {
  const matched = /Python\s+(\d+)\.(\d+)(?:\.(\d+))?/i.exec(text)
  if (!matched) return null
  return {
    major: Number(matched[1]),
    minor: Number(matched[2]),
    patch: Number(matched[3] ?? 0),
  }
}

function satisfiesMin(version: { major: number; minor: number }): boolean {
  return version.major > MIN_MAJOR || (version.major === MIN_MAJOR && version.minor >= MIN_MINOR)
}

function versionText(version: { major: number; minor: number; patch: number }): string {
  return `${version.major}.${version.minor}.${version.patch}`
}

export interface PythonCheckOptions {
  /** 候选命令链（测试注入用；缺省 python → py） */
  candidates?: string[]
  /** 单候选超时（毫秒），测试可注入小值 */
  timeoutMs?: number
}

export function createPythonEnvCheck(options: PythonCheckOptions = {}): EnvCheckItem {
  const candidates = options.candidates ?? CANDIDATES
  const timeoutMs = options.timeoutMs ?? PROBE_TIMEOUT_MS

  return {
    id: PYTHON_CHECK_ID,
    name: 'Python 环境',
    description: `本机 Python 版本 ≥ ${MIN_MAJOR}.${MIN_MINOR}（候选命令：${candidates.join(' → ')}）`,
    async run(): Promise<EnvCheckOutcome> {
      const started = Date.now()
      // 每个候选一次尝试记录；steps（结论链）与 details（排障细节）从中筛分 ——
      // 「python 超时但 py 成功」时结论不应被已恢复的超时污染，超时细节进 details
      const attempts: EnvCheckStep[] = []
      const tried: string[] = []
      // 胜出的候选：命令名 + 解析出的版本 + 对应的探测步骤
      let winner: { command: string; version: { major: number; minor: number; patch: number }; step: EnvCheckStep } | null =
        null

      for (const command of candidates) {
        tried.push(command)
        const stepStarted = Date.now()
        try {
          const output = await runCommand(command, ['--version'], { timeoutMs })
          const version = parseVersion(output.stdout) ?? parseVersion(output.stderr)
          if (output.exitCode !== 0 || !version) {
            // 典型：微软商店 stub（退出码 9009 无输出）、`py` 在没有 Python 时报错
            const raw = (output.stderr || output.stdout).trim().slice(0, 200)
            attempts.push({
              name: `命令探测（${command}）`,
              status: 'fail',
              summary: raw
                ? `退出码 ${output.exitCode}：${raw}`
                : `退出码 ${output.exitCode}，未回传版本号`,
              durationMs: Date.now() - stepStarted,
            })
            continue
          }
          const step: EnvCheckStep = {
            name: `命令探测（${command}）`,
            status: 'ok',
            summary: versionText(version),
            durationMs: Date.now() - stepStarted,
          }
          attempts.push(step)
          winner = { command, version, step }
          break // 首个能报版本的候选即胜出，不再尝试后续候选
        } catch (error) {
          attempts.push(stepFromError(`命令探测（${command}）`, error, stepStarted))
        }
      }

      const detailLines = attempts.map((step) => `${step.name}：${step.summary}`)

      if (!winner) {
        const status = worstStatus(attempts)
        return {
          status,
          summary:
            status === 'timeout'
              ? 'Python 探测超时：命令响应过慢，建议检查本机负载或杀毒软件拦截'
              : `未找到可用的 Python（已尝试 ${tried.join('、')}）—— 请安装 Python ${MIN_MAJOR}.${MIN_MINOR} 及以上版本`,
          details: detailLines.join('\n'),
          steps: attempts,
          durationMs: Date.now() - started,
        }
      }

      // —— 版本判定（结论链只保留胜者探测 + 版本结论，其余尝试留在 details） ——
      const versionStarted = Date.now()
      const met = satisfiesMin(winner.version)
      const versionStep: EnvCheckStep = {
        name: `版本要求（≥ ${MIN_MAJOR}.${MIN_MINOR}）`,
        status: met ? 'ok' : 'fail',
        summary: met
          ? `${versionText(winner.version)} 满足要求`
          : `${versionText(winner.version)} 低于 ${MIN_MAJOR}.${MIN_MINOR}，请升级 Python`,
        durationMs: Date.now() - versionStarted,
      }
      const status = worstStatus([winner.step, versionStep])

      return {
        status,
        summary: met
          ? `Python ${versionText(winner.version)}（命令 ${winner.command}），满足 ≥ ${MIN_MAJOR}.${MIN_MINOR} 要求`
          : `Python ${versionText(winner.version)}（命令 ${winner.command}）低于 ${MIN_MAJOR}.${MIN_MINOR}，不满足要求`,
        details: detailLines.length > 1 ? `其余候选尝试：\n${detailLines.join('\n')}` : undefined,
        steps: [winner.step, versionStep],
        durationMs: Date.now() - started,
      }
    },
  }
}

/** 把 runCommand 的异常翻译成步骤结论（不重抛 —— 探测永不 reject；与 welink 探测器同款） */
function stepFromError(stepName: string, error: unknown, started: number): EnvCheckStep {
  const durationMs = Date.now() - started
  const message = error instanceof Error ? error.message : String(error)
  const isTimeout = error instanceof WelinkError && TIMEOUT_MESSAGE.test(message)
  if (isTimeout) {
    return { name: stepName, status: 'timeout', summary: `超时（${durationMs}ms）未返回`, durationMs }
  }
  return { name: stepName, status: 'fail', summary: message, durationMs }
}
