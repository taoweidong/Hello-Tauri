import { describe, expect, it } from 'vitest'

/**
 * 路由表 → 侧栏派生的单测（A-1）。
 *
 * 这一层要守住的是「**导航只有一份真值**」这个不变量：侧栏不再维护自己的
 * `navItems` 数组，而是读路由表的 `meta`。因此测试的对象是派生函数本身：
 *  * 有 `icon` 的路由必须出现在导航里（加了页面却忘了图标 = 页面不可达）；
 *  * `hidden` 的路由必须被排除（404 兜底、详情页不该进侧栏）；
 *  * 排序按 `order` 而不是声明顺序（否则插一条路由就会打乱既有顺序）；
 *  * 返回值是纯数据（path/title/icon），不含 router 内部字段（组件直接 v-for 用）。
 *
 * 注意：这里 import 的是路由模块，它会执行 `createRouter`。hash 模式需要
 * `window`，测试环境是 happy-dom，因此无需额外打桩。
 */
import { navRoutes } from '@/router'

describe('router —— 侧栏导航由路由表派生（A-1 单一真值）', () => {
  it('派生结果包含全部五个核心页面且顺序与设计一致', () => {
    expect(navRoutes().map((item) => item.title)).toEqual(['概览', '数据管理', 'WeLink 助手', '配置', '关于'])
  })

  it('派生结果只含 path / title / icon 三个字段（模板直接消费，不外泄 router 内部结构）', () => {
    for (const item of navRoutes()) {
      expect(Object.keys(item).sort()).toEqual(['icon', 'path', 'title'])
    }
  })

  it('每个导航项都有图标（无图标的页面不会进侧栏 —— 这是过滤依据本身）', () => {
    for (const item of navRoutes()) {
      expect(item.icon).toBeTruthy()
    }
  })

  it('404 兜底路由不进侧栏（hidden 生效）', () => {
    const paths = navRoutes().map((item) => item.path)
    expect(paths).not.toContain('/:pathMatch(.*)*')
  })

  it('路径与标题一一对应且无重复（重复会让侧栏出现两个同样入口）', () => {
    const items = navRoutes()
    expect(new Set(items.map((item) => item.path)).size).toBe(items.length)
    expect(new Set(items.map((item) => item.title)).size).toBe(items.length)
  })

  it('返回的是新数组（外部排序不会污染路由表本身）', () => {
    const first = navRoutes()
    first.reverse()
    // 再次派生必须仍是声明顺序 —— 若返回的是内部数组引用就会被上一步改坏
    expect(navRoutes().map((item) => item.title)).toEqual(['概览', '数据管理', 'WeLink 助手', '配置', '关于'])
  })
})
