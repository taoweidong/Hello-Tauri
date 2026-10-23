import { describe, expect, it, vi } from 'vitest'
import type { Router } from 'vue-router'

/**
 * 路由跳转出口的直连用例（第六轮收口）。
 *
 * 四种语义必须钉住：
 *  ① 同路径守卫：重复 push 当前路由会 reject（NavigationDuplicated），守卫必须挡住；
 *  ② 不同路径照常 push；
 *  ③ **失败不冒泡**：导航守卫中断 / 路由不存在时 push 会 reject，漏一个 catch
 *     就是一个未处理拒绝（用户点了没反应、控制台一行警告）；
 *  ④ `current` 是**取值器**而不是快照 —— 必须在点击那一刻读当前路由。
 *
 * 反证（写用例时实跑过）：把同路径守卫删掉 → 用例① 变红；去掉 `.catch` →
 * 用例③ 变红；把 `current` 改成字符串快照 → 用例⑤ 变红。
 */
const logger = vi.hoisted(() => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() }))
vi.mock('@/utils/logger', () => ({ logger }))

import { createGo } from './nav'

function routerOf(push: (to: string) => unknown) {
  return { push } as unknown as Router
}

describe('createGo', () => {
  it('目标与当前路径相同时不 push（挡掉重复导航的 reject）', () => {
    const push = vi.fn(() => Promise.resolve())
    createGo(routerOf(push), { current: () => '/' })('/')
    expect(push).not.toHaveBeenCalled()
  })

  it('目标不同则照常 push', () => {
    const push = vi.fn(() => Promise.resolve())
    createGo(routerOf(push), { current: () => '/' })('/settings')
    expect(push).toHaveBeenCalledWith('/settings')
  })

  it('不给 current 时不做守卫（是否守卫由调用方决定）', () => {
    const push = vi.fn(() => Promise.resolve())
    createGo(routerOf(push))('/')
    expect(push).toHaveBeenCalledWith('/')
  })

  it('push 失败只写日志，不产生未处理拒绝', async () => {
    const push = vi.fn(() => Promise.reject(new Error('Navigation aborted')))
    expect(() => createGo(routerOf(push))('/nope')).not.toThrow()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('导航失败（/nope）'))
  })

  it('current 取的是跳转那一刻的路径（函数而非快照）', () => {
    const push = vi.fn(() => Promise.resolve())
    let current = '/a'
    const go = createGo(routerOf(push), { current: () => current })
    go('/a')
    expect(push).not.toHaveBeenCalled()
    // 当前路径变了之后，同一个目标就该放行
    current = '/b'
    go('/a')
    expect(push).toHaveBeenCalledWith('/a')
  })
})
