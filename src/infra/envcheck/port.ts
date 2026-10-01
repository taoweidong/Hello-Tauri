/**
 * 环境检测端口 —— 检测「本机 CLI 依赖环境」的外部世界形状。
 *
 * 设计要点（为什么不是复用 WelinkPort）：
 *  * 环境检测是**只读诊断**，与消息/建群端口的重试、幂等语义完全无关；
 *  * 检测项天然是「清单」形态（welink-cli 今天 1 项，明天可能接入其他 CLI），
 *    用 `EnvCheckItem[]` 注册表表达，UI 与 store 对具体项数无知；
 *  * 每个检测项自带硬超时（`withHardTimeout`），保证**任何情况下**都能在预算
 *    时间内给出确定结果 —— 这是本模块的第一铁律：检测绝不能让页面无限等待。
 *
 * 新增一个 CLI 环境检测的步骤：
 *  1. 在 `infra/` 下写一个返回 `EnvCheckItem` 的探测器文件（子命令假设标 [CLI-ASSUME]）；
 *  2. 在 `envcheck/index.ts` 的 `createEnvChecks` 里注册；
 *  3. 若新 CLI 不在 Rust 白名单内（当前仅放行 `welink-cli`），需要同步放宽
 *     `src-tauri/src/cli.rs` 的 `ALLOWED_STEM` —— 这是唯一一处必须动 Rust 的场景。
 */

/** 单项检测的状态（UI 的标签与汇总横幅都由它派生） */
export type EnvCheckStatus = 'ok' | 'warn' | 'fail' | 'timeout'

/** 检测过程中的一个步骤（如「可执行文件检查」「环境自检」），供 UI 分行展示 */
export interface EnvCheckStep {
  /** 步骤名（中文，直接展示） */
  name: string
  status: EnvCheckStatus
  /** 一句话结论 */
  summary: string
  durationMs: number
}

/** 一个检测项的完整结果 */
export interface EnvCheckOutcome {
  /** 各步骤的最坏状态（fail > timeout > warn > ok） */
  status: EnvCheckStatus
  /** 一句话人读结论（列表行直接展示） */
  summary: string
  /** 多行诊断细节（stderr 摘录等），可为空 */
  details?: string
  steps: EnvCheckStep[]
  durationMs: number
}

/** 一个环境检测项（注册表的最小单元） */
export interface EnvCheckItem {
  /** 稳定 ID（store 按它合并状态；新增检测项不得复用旧 ID） */
  id: string
  /** 展示名（如「WeLink CLI」） */
  name: string
  /** 一句话说明检测什么 */
  description: string
  /**
   * 执行检测。契约：**永不 reject**（实现内部必须把一切异常折叠成 outcome），
   * 且必须在硬超时预算内 resolve —— 工厂层会用 `withHardTimeout` 再包一层兜底。
   */
  run(): Promise<EnvCheckOutcome>
}

/** 状态严重度：数值越大越严重，用于取「最坏步骤」 */
const SEVERITY: Record<EnvCheckStatus, number> = { ok: 0, warn: 1, timeout: 2, fail: 3 }

/** 取一组步骤的最坏状态 */
export function worstStatus(steps: EnvCheckStep[]): EnvCheckStatus {
  return steps.reduce<EnvCheckStatus>((worst, step) => (SEVERITY[step.status] > SEVERITY[worst] ? step.status : worst), 'ok')
}

/**
 * 硬超时包装：`task` 无论挂起多久、抛什么错，都折叠成一个确定的结果。
 *
 * 三条语义（改代码别丢）：
 *  1. 超时返回 `timeout` 结果而不是 reject —— 调用方（store）因此可以假设
 *     `run()` 永不失败，UI 状态机没有「异常未处理」分支；
 *  2. 硬超时只是「不再等待」：底层子进程无法从 TS 侧取消，进程回收仍由
 *     Rust 侧超时（15s 兜底）负责 —— 两侧预算必须满足 Rust < 硬超时链路合理，
 *     单次 CLI 调用的预算要显式小于本硬超时；
 *  3. 定时器在 settle 后必须清除，否则会拖住定时器队列（测试 fake timers 下尤为明显）。
 */
export async function withHardTimeout(task: () => Promise<EnvCheckOutcome>, timeoutMs: number, label: string): Promise<EnvCheckOutcome> {
  const started = Date.now()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await new Promise<EnvCheckOutcome>((resolve) => {
      timer = setTimeout(() => {
        resolve({
          status: 'timeout',
          summary: `检测超时（超过 ${timeoutMs}ms 未返回）：${label}`,
          details: `检测项：${label}。\n已放弃等待本次检测；底层进程由宿主侧超时负责回收，不影响其他页面。`,
          steps: [],
          durationMs: Date.now() - started,
        })
      }, timeoutMs)
      task()
        .then(resolve)
        .catch((error: unknown) => {
          // 理论上探测实现内部已折叠异常；这里是最后一道防线（防 unhandled rejection）
          resolve({
            status: 'fail',
            summary: `检测执行异常：${error instanceof Error ? error.message : String(error)}`,
            steps: [],
            durationMs: Date.now() - started,
          })
        })
    })
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}
