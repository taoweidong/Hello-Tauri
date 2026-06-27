type TaskFn = () => Promise<any>

interface QueuedTask {
  id: string
  fn: TaskFn
  resolve: (value: any) => void
  reject: (reason: any) => void
  promise: Promise<any>
}

let nextId = 0

export class TaskScheduler {
  private maxConcurrency: number
  private maxQueueSize: number
  private running = 0
  private queue: QueuedTask[] = []
  private promises = new Map<string, Promise<any>>()
  private taskFns = new Map<string, TaskFn>()

  constructor(maxConcurrency = 3, maxQueueSize = 100) {
    this.maxConcurrency = maxConcurrency
    this.maxQueueSize = maxQueueSize
  }

  enqueue(fn: TaskFn): string | null {
    if (this.queue.length >= this.maxQueueSize) return null

    const id = `task_${nextId++}`
    let resolve!: (value: any) => void
    let reject!: (reason: any) => void
    const promise = new Promise((res, rej) => { resolve = res; reject = rej })

    const task: QueuedTask = { id, fn, resolve, reject, promise }
    this.queue.push(task)
    this.promises.set(id, promise)
    this.taskFns.set(id, fn)
    this.processNext()
    return id
  }

  getPromise(id: string): Promise<any> | undefined {
    return this.promises.get(id)
  }

  retry(id: string): string | null {
    const fn = this.taskFns.get(id)
    if (!fn) return null
    this.promises.delete(id)
    this.taskFns.delete(id)
    return this.enqueue(fn)
  }

  private processNext() {
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
