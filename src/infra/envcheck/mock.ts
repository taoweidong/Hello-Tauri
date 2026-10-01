/**
 * 环境检测的模拟实现（[MOCK-CLI]）。
 *
 * [MOCK-CLI] 浏览器调试模式（无子进程通道）与单测的数据源：模拟各检测项
 * （welink-cli、Python）正常通过。对接真实 CLI 后**保留**本文件 —— 它是浏览器模式
 * 唯一能用的数据源（web Bridge 的 cliRun 明确报错，见 `api/web.ts`），也是 UI
 * 开发的确定性夹具。
 *
 * 模拟结果必须可辨识：summary 以「【模拟】」开头，页面同时有「模拟检测」徽标，
 * 双保险防止把模拟结果误读为本机真实环境。
 */
import type { EnvCheckItem, EnvCheckOutcome } from './port'
import { PYTHON_CHECK_ID } from './python'
import { WELINK_CHECK_ID } from './welink'

export interface MockEnvCheckOptions {
  /** 模拟检测耗时（毫秒）：默认给个真实感延迟，测试可传 0 */
  delayMs?: number
  /** 覆盖模拟结论（测试注入 warn/fail 场景用） */
  overrides?: Record<string, Partial<EnvCheckOutcome>>
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function createMockEnvChecks(options: MockEnvCheckOptions = {}): EnvCheckItem[] {
  const delay = options.delayMs ?? 400

  const welinkCheck: EnvCheckItem = {
    id: WELINK_CHECK_ID,
    name: 'WeLink CLI',
    description: 'welink-cli 可执行文件与运行环境（模拟数据源）',
    async run(): Promise<EnvCheckOutcome> {
      await sleep(delay)
      const base: EnvCheckOutcome = {
        status: 'ok',
        summary: '【模拟】welink-cli 可用（mock 1.0.0），环境自检通过',
        details: '浏览器调试模式无法执行本地命令，以上为模拟结论；桌面模式将真实执行 welink-cli。',
        steps: [
          { name: '可执行检查', status: 'ok', summary: '【模拟】可正常执行（mock 1.0.0）', durationMs: Math.round(delay / 2) },
          { name: '环境自检', status: 'ok', summary: '【模拟】CLI 环境自检通过', durationMs: Math.round(delay / 2) },
        ],
        durationMs: delay,
      }
      return { ...base, ...(options.overrides?.[WELINK_CHECK_ID] ?? {}) }
    },
  }

  return [welinkCheck, mockPythonCheck(options)]
}

/** Python 项的模拟结果（与 welink 项同款可辨识约定，抽出为独立函数便于拼装） */
export function mockPythonCheck(options: MockEnvCheckOptions = {}): EnvCheckItem {
  const delay = options.delayMs ?? 400

  return {
    id: PYTHON_CHECK_ID,
    name: 'Python 环境',
    description: '本机 Python 版本 ≥ 3.10（模拟数据源）',
    async run(): Promise<EnvCheckOutcome> {
      await sleep(delay)
      const base: EnvCheckOutcome = {
        status: 'ok',
        summary: '【模拟】Python 3.12.4（命令 python），满足 ≥ 3.10 要求',
        details: '浏览器调试模式无法执行本地命令，以上为模拟结论；桌面模式将真实执行 python/py --version。',
        steps: [
          { name: '命令探测（python）', status: 'ok', summary: '【模拟】3.12.4', durationMs: Math.round(delay / 2) },
          {
            name: '版本要求（≥ 3.10）',
            status: 'ok',
            summary: '【模拟】3.12.4 满足要求',
            durationMs: Math.round(delay / 2),
          },
        ],
        durationMs: delay,
      }
      return { ...base, ...(options.overrides?.[PYTHON_CHECK_ID] ?? {}) }
    },
  }
}
