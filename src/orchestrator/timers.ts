/**
 * 定时器抽象（设计 §5-P2）。
 *
 * 为什么不用裸 `setTimeout`：poller 与 pipeline 的「完成后再排下一轮」语义
 * 必须能在**假时钟**下断言（`orchestrator/poller.spec.ts` 要验证 setTimeout 链、
 * single-flight、退避序列）。注入一层薄的 TimerApi 让测试可以完全掌控时间推进，
 * 而不必依赖 `vi.useFakeTimers()` 与真实宏任务队列的交互细节。
 */
export interface TimerApi {
  /** 排一个一次性定时器，返回句柄（供 clear） */
  set(handler: () => void, delayMs: number): unknown
  clear(id: unknown): void
}

export const realTimers: TimerApi = {
  set(handler, delayMs) {
    return setTimeout(handler, Math.max(0, delayMs))
  },
  clear(id) {
    if (id !== null && id !== undefined) clearTimeout(id as ReturnType<typeof setTimeout>)
  },
}
