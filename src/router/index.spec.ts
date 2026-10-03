import { describe, expect, it } from 'vitest'

import { DEFAULT_NAV_GROUP, NAV_GROUP_ORDER, navGroups, navRoutes } from '@/router'

/**
 * 路由表 → 侧栏派生的单测（A-1 + personal-workbench 分组）。
 *
 * 这层守住的不变量：
 *  * 「导航只有一份真值」：侧栏（含分组）完全由路由表 meta 派生；
 *  * 有 `icon` 的路由必须出现在导航里（加页面忘了图标 = 页面不可达）；
 *  * `hidden` 的路由必须被排除（404 兜底不进侧栏）；
 *  * 排序按 `order`；分组按 NAV_GROUP_ORDER 归置；
 *  * **未声明分组的带图标路由归入默认分组**（引入分组不得让任何路由消失）；
 *  * 返回值是纯数据（path/title/icon/group），不含 router 内部字段。
 *
 * 注意：这里 import 的是路由模块，它会执行 `createRouter`。hash 模式需要
 * `window`，测试环境是 happy-dom，因此无需额外打桩。
 */
describe('router —— 侧栏导航由路由表派生（A-1 单一真值）', () => {
  it('派生结果包含全部八个核心页面且顺序与设计一致', () => {
    expect(navRoutes().map((item) => item.title)).toEqual([
      '工作台',
      '数据管理',
      'WeLink 助手',
      '快速建群',
      'CodeHub 检视',
      '配置',
      '环境检测',
      '关于',
    ])
  })

  it('派生结果只含 path / title / icon / group 四个字段（模板直接消费，不外泄 router 内部结构）', () => {
    for (const item of navRoutes()) {
      expect(Object.keys(item).sort()).toEqual(['group', 'icon', 'path', 'title'])
    }
  })

  it('每个导航项都有图标与分组（无图标不进侧栏 —— 过滤依据本身；分组缺失补默认值）', () => {
    for (const item of navRoutes()) {
      expect(item.icon).toBeTruthy()
      expect(item.group).toBeTruthy()
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
    expect(navRoutes().map((item) => item.title)).toEqual([
      '工作台',
      '数据管理',
      'WeLink 助手',
      '快速建群',
      'CodeHub 检视',
      '配置',
      '环境检测',
      '关于',
    ])
  })
})

describe('router —— 侧栏分组（personal-workbench）', () => {
  it('navGroups 按约定顺序归置四组，组内沿用 order 排序', () => {
    const groups = navGroups()
    expect(groups.map((group) => group.name)).toEqual(['工作台', 'WeLink', 'CodeHub', '系统'])
    expect(groups[0]!.items.map((item) => item.title)).toEqual(['工作台', '数据管理'])
    expect(groups[1]!.items.map((item) => item.title)).toEqual(['WeLink 助手', '快速建群'])
    expect(groups[2]!.items.map((item) => item.title)).toEqual(['CodeHub 检视'])
    expect(groups[3]!.items.map((item) => item.title)).toEqual(['配置', '环境检测', '关于'])
  })

  it('所有带图标路由都被分组覆盖（不因引入分组而丢失）', () => {
    const groupedCount = navGroups().reduce((sum, group) => sum + group.items.length, 0)
    expect(groupedCount).toBe(navRoutes().length)
  })

  it('约定分组清单全部出现在 navGroups 里（顺序真值自洽）', () => {
    const names = navGroups().map((group) => group.name)
    for (const name of NAV_GROUP_ORDER) expect(names).toContain(name)
  })

  it('默认分组常量为「工作台」（首页所在组）', () => {
    expect(DEFAULT_NAV_GROUP).toBe('工作台')
    expect(navRoutes()[0]!.group).toBe('工作台')
  })
})
