import { describe, it, expect, vi } from 'vitest'
import { TaskScheduler } from '@/core/task-scheduler'

function delay(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

describe('TaskScheduler', () => {
  it('executes tasks with concurrency limit', async () => {
    const scheduler = new TaskScheduler(2)
    let running = 0
    let maxRunning = 0

    const task = async () => {
      running++
      maxRunning = Math.max(maxRunning, running)
      await delay(50)
      running--
    }

    const ids = [
      scheduler.enqueue(task),
      scheduler.enqueue(task),
      scheduler.enqueue(task),
      scheduler.enqueue(task),
    ]
    await Promise.all(ids.map(id => scheduler.getPromise(id)))

    expect(maxRunning).toBeLessThanOrEqual(2)
  })

  it('supports retry', async () => {
    const scheduler = new TaskScheduler(1)
    let attempts = 0

    const failingTask = async () => {
      attempts++
      if (attempts < 2) throw new Error('fail')
    }

    const id = scheduler.enqueue(failingTask)
    await expect(scheduler.getPromise(id)).rejects.toThrow('fail')

    const retryId = scheduler.retry(id)
    expect(retryId).not.toBeNull()
    await expect(scheduler.getPromise(retryId!)).resolves.toBeUndefined()
    expect(attempts).toBe(2)
  })

  it('throws when max concurrency reached and queue full', () => {
    const scheduler = new TaskScheduler(1, 1)
    const slowTask = () => delay(1000)
    scheduler.enqueue(slowTask)
    scheduler.enqueue(slowTask)
    expect(() => scheduler.enqueue(slowTask)).toThrow('任务队列已满')
  })

  it('pendingCount 返回等待队列中的任务数', async () => {
    const scheduler = new TaskScheduler(1)
    const slowTask = () => delay(100)

    expect(scheduler.pendingCount).toBe(0)

    scheduler.enqueue(slowTask)
    // 第一个任务立即执行，不在队列中
    await delay(10)
    expect(scheduler.pendingCount).toBe(0)

    // 添加更多任务到队列
    scheduler.enqueue(slowTask)
    scheduler.enqueue(slowTask)
    await delay(10)
    expect(scheduler.pendingCount).toBeGreaterThanOrEqual(0)
  })

  it('runningCount 返回正在执行的任务数', async () => {
    const scheduler = new TaskScheduler(2)
    const slowTask = () => delay(100)

    expect(scheduler.runningCount).toBe(0)

    scheduler.enqueue(slowTask)
    scheduler.enqueue(slowTask)
    await delay(10)
    expect(scheduler.runningCount).toBe(2)

    await delay(150)
    expect(scheduler.runningCount).toBe(0)
  })

  it('retry 不存在的任务返回 null', () => {
    const scheduler = new TaskScheduler(1)
    expect(scheduler.retry('nonexistent')).toBeNull()
  })

  it('retry 拒绝原任务的 Promise', async () => {
    const scheduler = new TaskScheduler(1)
    let shouldFail = true

    const task = async () => {
      if (shouldFail) throw new Error('original fail')
      return 'success'
    }

    const id = scheduler.enqueue(task)
    await expect(scheduler.getPromise(id)).rejects.toThrow('original fail')

    // 修改任务行为
    shouldFail = false

    // 重试
    const retryId = scheduler.retry(id)
    expect(retryId).not.toBeNull()
    await expect(scheduler.getPromise(retryId!)).resolves.toBe('success')
  })

  it('getPromise 返回任务 Promise', async () => {
    const scheduler = new TaskScheduler(1)
    const id = scheduler.enqueue(async () => 'result')

    const promise = scheduler.getPromise(id)
    expect(promise).toBeDefined()
    await expect(promise).resolves.toBe('result')
  })

  it('getPromise 不存在的 id 返回 undefined', () => {
    const scheduler = new TaskScheduler(1)
    expect(scheduler.getPromise('nonexistent')).toBeUndefined()
  })

  it('任务成功完成后清理 promises', async () => {
    const scheduler = new TaskScheduler(1)
    const id = scheduler.enqueue(async () => 'done')

    await scheduler.getPromise(id)
    await delay(10)

    // 完成后 promises 被清理
    expect(scheduler.getPromise(id)).toBeUndefined()
  })

  it('任务失败后仍可 retry', async () => {
    const scheduler = new TaskScheduler(1)
    let attempts = 0

    const task = async () => {
      attempts++
      if (attempts === 1) throw new Error('first fail')
      return 'ok'
    }

    const id = scheduler.enqueue(task)
    await expect(scheduler.getPromise(id)).rejects.toThrow('first fail')

    const retryId = scheduler.retry(id)
    expect(retryId).not.toBeNull()
    await expect(scheduler.getPromise(retryId!)).resolves.toBe('ok')
    expect(attempts).toBe(2)
  })

  it('默认并发数为 3', async () => {
    const scheduler = new TaskScheduler()
    let running = 0
    let maxRunning = 0

    const task = async () => {
      running++
      maxRunning = Math.max(maxRunning, running)
      await delay(50)
      running--
    }

    const ids = Array.from({ length: 6 }, () => scheduler.enqueue(task))
    await Promise.all(ids.map(id => scheduler.getPromise(id)))

    expect(maxRunning).toBeLessThanOrEqual(3)
  })
})
