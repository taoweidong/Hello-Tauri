/**
 * 路由跳转的统一出口（第六轮 UI 一致性收口）。
 *
 * 为什么收口：`go()` 被抄了三份且**实现互不一致**——
 *  - `MainLayout` 版：先判「目标 !== 当前路径」再 push（**无 catch**）；
 *  - `DashboardView` / `CodehubReviewView` 版：直接 push 后 `.catch(() => undefined)`
 *    （**无同路径守卫**）；
 *  - `WeLinkView` 版：**根本没定义**，直接裸 `await router.push(...).catch(...)`。
 *
 * 两种语义缺一不可，抄写时却总是二选一：
 *  1. **同路径守卫**：重复 push 当前路由会 reject（NavigationDuplicated）。
 *     工作台那种「点面板头跳详情」的入口极容易重复触发。
 *  2. **catch**：导航守卫中断 / 路由不存在时 push 会 reject —— 漏一个 catch 就是一个
 *     未处理拒绝，且**用户零感知**（点了没反应，控制台一行警告）。
 *
 * 失败只写日志、不弹 toast：跳转失败绝大多数原因是「已经在目标页」，
 * 弹提示反而是噪音（与 `runUiAction` 的「失败必提示」不同——那是**动作**，这是**导航**）。
 */
import type { Router } from 'vue-router'
import { logger } from '@/utils/logger'

export interface GoOptions {
  /**
   * 当前路径的取值器（给了就启用同路径守卫）。
   *
   * 传函数而不是字符串：必须在**点击那一刻**读当前路由，否则拿到的是 setup 期快照。
   */
  current?: () => string
}

/** 生成一个 `go(path)`：同路径跳过 + 失败写日志（永不 reject） */
export function createGo(router: Router, options: GoOptions = {}) {
  return function go(to: string): void {
    if (options.current && options.current() === to) return
    void router.push(to).catch((error: unknown) => {
      logger.warn(`导航失败（${to}）：${error instanceof Error ? error.message : String(error)}`)
    })
  }
}
