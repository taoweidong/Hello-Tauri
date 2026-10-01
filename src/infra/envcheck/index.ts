/**
 * 环境检测注册表工厂（[MOCK-CLI] mock/cli 切换点）。
 *
 * 与 `infra/welink/index.ts` 的端口工厂同款思路：上层只认 `EnvCheckItem[]`，
 * 浏览器模式强制 mock，桌面模式走真实探测器。与 welink 端口工厂的一个差别：
 * 探测器是**无状态**的（每次 run 都是独立子进程调用），无需按配置键缓存实例。
 *
 * 硬超时兜底是工厂层的职责而不是各探测器自己的事：统一预算（`HARD_TIMEOUT_MS`）
 * 保证「未来接入的任何探测器」即使忘写内部超时，也不会把页面挂住 —— 防御
 * 设在注册表入口，而不是指望每个实现者都记得。
 */
import { platform as runtime } from '@/api'
import { logger } from '@/utils/logger'
import { createMockEnvChecks } from './mock'
import type { EnvCheckItem } from './port'
import { withHardTimeout } from './port'
import { createPythonEnvCheck } from './python'
import { createWelinkEnvCheck } from './welink'

export { PYTHON_CHECK_ID } from './python'
export { WELINK_CHECK_ID } from './welink'
export type { EnvCheckItem, EnvCheckOutcome, EnvCheckStatus, EnvCheckStep } from './port'

/** 单个检测项的硬超时：必须大于各探测器内部 CLI 调用预算之和的最大值
 *  （welink 5s+8s=13s、python 2×5s=10s）—— 正常路径下内部超时先生效，
 *  硬超时只兜「bridge 挂死」等真正的异常情况 */
export const HARD_TIMEOUT_MS = 16_000

export interface EnvCheckOptions {
  /** 'cli' = 真实子进程探测；'mock' = 模拟数据源（浏览器/测试）。缺省按运行平台决定 */
  mode?: 'cli' | 'mock'
  welink?: {
    /** welink-cli 路径（空/缺省 = 探测 PATH 上的裸命令名） */
    cliPath?: string
  }
  /** 硬超时（毫秒），测试可注入小值 */
  hardTimeoutMs?: number
  /** mock 参数透传（测试注入延迟/覆盖结论） */
  mock?: Parameters<typeof createMockEnvChecks>[0]
}

/** 组装当前环境的检测项清单。调用方（store）在每次检测前调用，配置改动即时生效 */
export function createEnvChecks(options: EnvCheckOptions = {}): EnvCheckItem[] {
  const mode = options.mode ?? (runtime === 'tauri' ? 'cli' : 'mock')
  const hardTimeoutMs = options.hardTimeoutMs ?? HARD_TIMEOUT_MS

  const raw: EnvCheckItem[] =
    mode === 'cli'
      ? [createWelinkEnvCheck({ cliPath: options.welink?.cliPath }), createPythonEnvCheck()]
      : createMockEnvChecks(options.mock)

  if (mode === 'mock') logger.info('环境检测：模拟数据源（浏览器调试模式）')

  // 每一项都套硬超时 + 异常折叠：store 与 UI 对「检测挂死/抛错」零感知
  return raw.map((item) => ({
    ...item,
    run: () => withHardTimeout(item.run, hardTimeoutMs, item.name),
  }))
}
