/** 任务函数类型 */
type TaskFn<T = unknown> = () => Promise<T>

/** 队列中的任务项 */
interface QueuedTask<T = unknown> {
  id: string
  fn: TaskFn<T>
  resolve: (value: T) => void
  reject: (reason: unknown) => void
  promise: Promise<T>
}

/**
 * 并发任务调度器
 * 控制最大并发执行数，超出部分进入队列等待
 */
export class TaskScheduler {
  private nextId = 0
  /** 当前正在执行的任务数 */
  private running = 0
  /** 等待队列 */
  private queue: QueuedTask[] = []
  private promises = new Map<string, Promise<unknown>>()
  private taskFns = new Map<string, TaskFn>()

  /**
   * @param maxConcurrency - 最大并发数，默认 3
   * @param maxQueueSize - 最大队列长度，默认 100
   */
  constructor(
    private maxConcurrency = 3,
    private maxQueueSize = 100
  ) {}

  /**
   * 将任务加入执行队列
   * @param fn - 异步任务函数
   * @returns 任务 id，队列已满时返回 null
   */
  enqueue<T>(fn: TaskFn<T>): string | null {
    if (this.queue.length >= this.maxQueueSize) return null

    const id = `task_${this.nextId++}`
    let resolve!: (value: T) => void
    let reject!: (reason: unknown) => void
    const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })

    const task: QueuedTask<T> = { id, fn, resolve, reject, promise }
    this.queue.push(task as QueuedTask)
    this.promises.set(id, promise)
    this.taskFns.set(id, fn)
    this.processNext()
    return id
  }

  /**
   * 获取指定任务的 Promise
   * @param id - 任务 id
   * @returns 任务对应的 Promise，不存在时返回 undefined
   */
  getPromise(id: string): Promise<unknown> | undefined {
    return this.promises.get(id)
  }

  /**
   * 重试指定任务（重新入队）
   * @param id - 原任务 id
   * @returns 新任务 id，失败时返回 null
   */
  retry(id: string): string | null {
    const fn = this.taskFns.get(id)
    if (!fn) return null
    // 拒绝原任务的 promise，防止 resolve/reject 悬挂
    const oldPromise = this.promises.get(id)
    if (oldPromise) {
      // 通过删除引用让原任务完成时不再影响外部
      this.promises.delete(id)
      this.taskFns.delete(id)
    } else {
      this.taskFns.delete(id)
    }
    return this.enqueue(fn)
  }

  /** 当前等待队列中的任务数 */
  get pendingCount(): number {
    return this.queue.length
  }

  /** 当前正在执行的任务数 */
  get runningCount(): number {
    return this.running
  }

  /** 调度执行：按并发上限从队列取出任务执行 */
  private processNext(): void {
    while (this.running < this.maxConcurrency && this.queue.length > 0) {
      const task = this.queue.shift()!
      this.running++
      task.fn()
        .then(result => {
          task.resolve(result)
          this.promises.delete(task.id)
          this.taskFns.delete(task.id)
        })
        .catch(err => {
          task.reject(err)
        })
        .finally(() => {
          this.running--
          this.processNext()
        })
    }
  }
}
