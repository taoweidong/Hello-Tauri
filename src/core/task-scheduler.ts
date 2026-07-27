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
  /** 正在执行中的任务映射（id → 任务项，供 retry 定位 running 任务） */
  private runningTasks = new Map<string, QueuedTask>()
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
   * @returns 任务 id
   * @throws 队列已满时抛出错误
   */
  enqueue<T>(fn: TaskFn<T>): string {
    if (this.queue.length >= this.maxQueueSize) {
      throw new Error(`任务队列已满 (上限 ${this.maxQueueSize})`)
    }

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
   * 主动拒绝原任务的 Promise，防止外部悬挂等待；
   * 若原任务正在执行，其后续结果会被忽略（Promise 已 settle），避免重复生效
   * @param id - 原任务 id
   * @returns 新任务 id，找不到原任务时返回 null
   */
  retry(id: string): string | null {
    const fn = this.taskFns.get(id)
    if (!fn) return null
    // 定位原任务：优先查排队中队列，其次查执行中映射（P5 running 边界修复）
    const task = this.queue.find(t => t.id === id) ?? this.runningTasks.get(id)
    if (task) {
      // 拒绝原任务的 Promise，防止外部等待悬挂；
      // running 任务无法真正中断，但 Promise 已 settle，其后续 resolve/reject 会被忽略
      task.reject(new Error('任务已重试，原任务已废弃'))
    }
    // 清理原任务引用
    this.promises.delete(id)
    this.taskFns.delete(id)
    // 从队列中移除原任务（如果还在排队）
    this.queue = this.queue.filter(t => t.id !== id)
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
      this.runningTasks.set(task.id, task)
      task.fn()
        .then(result => {
          task.resolve(result)
        })
        .catch(err => {
          task.reject(err)
        })
        .finally(() => {
          // promises 完成后清理，taskFns 保留以供 retry 使用
          this.runningTasks.delete(task.id)
          this.promises.delete(task.id)
          this.running--
          this.processNext()
        })
    }
  }
}
