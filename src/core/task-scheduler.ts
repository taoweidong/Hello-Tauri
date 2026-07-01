type TaskFn<T = unknown> = () => Promise<T>

interface QueuedTask<T = unknown> {
  id: string
  fn: TaskFn<T>
  resolve: (value: T) => void
  reject: (reason: unknown) => void
  promise: Promise<T>
}

export class TaskScheduler {
  private nextId = 0
  private running = 0
  private queue: QueuedTask[] = []
  private promises = new Map<string, Promise<unknown>>()
  private taskFns = new Map<string, TaskFn>()

  constructor(
    private maxConcurrency = 3,
    private maxQueueSize = 100
  ) {}

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

  getPromise(id: string): Promise<unknown> | undefined {
    return this.promises.get(id)
  }

  retry(id: string): string | null {
    const fn = this.taskFns.get(id)
    if (!fn) return null
    this.promises.delete(id)
    this.taskFns.delete(id)
    return this.enqueue(fn)
  }

  get pendingCount(): number {
    return this.queue.length
  }

  get runningCount(): number {
    return this.running
  }

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
