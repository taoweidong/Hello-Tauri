/**
 * 异步横切原语（quality-hardening-2026-10，design D5）——infra 工厂层共用的
 * 「硬超时 + 异常折叠」语义，收敛 envcheck 与 windows 两份变体实现。
 *
 * 两条从既有实现继承的教训：
 *  1. 定时器在 settle 后**必须清除**，否则会拖住定时器队列（fake timers 测试下
 *     尤为明显 —— `vi.getTimerCount()` 是验收手段之一）；
 *  2. 超时只是「不再等待」：底层任务无法从 TS 侧取消，进程回收仍由宿主侧
 *     （Rust 超时兜底）负责 —— 调用方预算必须小于宿主侧预算。
 */

/**
 * 硬超时包装：`task` 在 `timeoutMs` 内未完成则确定性 resolve `onTimeout()` 的
 * 结果；rejection **原样传播**（通道故障语义由调用方决定是否再包一层
 * `foldRejection`）。settle 后定时器必然清除。
 */
export async function withHardTimeout<T>(
  task: () => Promise<T>,
  timeoutMs: number,
  onTimeout: () => T,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await new Promise<T>((resolve, reject) => {
      timer = setTimeout(() => resolve(onTimeout()), timeoutMs)
      task().then(resolve, reject)
    })
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/**
 * 异常折叠包装：`task` 的 rejection 经 `onFailure` 折叠为确定结果——包装后的
 * 调用**永不 reject**。成功值原样透传。
 */
export async function foldRejection<T>(
  task: () => Promise<T>,
  onFailure: (error: unknown) => T,
): Promise<T> {
  try {
    return await task()
  } catch (error) {
    return onFailure(error)
  }
}
