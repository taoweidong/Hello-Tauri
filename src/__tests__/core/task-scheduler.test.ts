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

    await Promise.all([
      scheduler.enqueue(task),
      scheduler.enqueue(task),
      scheduler.enqueue(task),
      scheduler.enqueue(task),
    ])

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
    await expect(scheduler.getPromise(id!)).rejects.toThrow('fail')

    const retryId = scheduler.retry(id!)
    await expect(scheduler.getPromise(retryId!)).resolves.toBeUndefined()
    expect(attempts).toBe(2)
  })

  it('returns null when max concurrency reached and queue full', () => {
    const scheduler = new TaskScheduler(1, 1)
    const slowTask = () => delay(1000)
    scheduler.enqueue(slowTask)
    scheduler.enqueue(slowTask)
    const third = scheduler.enqueue(slowTask)
    expect(third).toBeNull()
  })
})
