import { createRouter, createWebHashHistory, type RouteRecordRaw } from 'vue-router'
import {
  IconGrid,
  IconTable,
  IconActivity,
  IconUsers,
  IconSliders,
  IconCircleCheck,
  IconInfo,
  IconGitBranch,
} from '@/components/icons'

/**
 * 路由表是导航的**唯一真值**（A-1）。
 *
 * 此前侧栏（`MainLayout.vue` 的 `navItems` 数组）与路由表各写一份标题与顺序，
 * 加一个页签要改两处、漏一处就出现「路由能进但侧栏没有」或反之；`uitest.mjs`
 * 还把这五个标题硬编码成断言，等于第三份真值。
 *
 * 现在只在 `meta` 上声明导航元数据，侧栏由 `navRoutes()` / `navGroups()` 派生：
 *  * `title`   —— 侧栏文案 + 页面标题（原有字段，继续沿用）
 *  * `icon`    —— 侧栏图标组件
 *  * `order`   —— 排序权重（不写则按声明顺序，显式写便于插页面时不动别处）
 *  * `hidden`  —— 不出现在侧栏（登录页、详情页、404 等）
 *  * `group`   —— 侧栏分组名（personal-workbench；缺省归入默认分组）
 *
 * **新增页面只需在这里加一条**，侧栏自动出现，`MainLayout.vue` 零改动。
 */

declare module 'vue-router' {
  interface RouteMeta {
    /** 侧栏文案与文档标题 */
    title: string
    /** 侧栏图标（内联 SVG 组件；不写则该页不进侧栏视图） */
    icon?: unknown
    /** 侧栏排序权重，越小越靠前 */
    order?: number
    /** 是否隐藏于侧栏 */
    hidden?: boolean
    /** 侧栏分组名；不写的带图标路由归入默认分组（不丢失，spec「未分组路由不丢失」） */
    group?: string
  }
}

/** 导航项（侧栏渲染所需的最小形状） */
export interface NavItem {
  path: string
  title: string
  icon: unknown
  /** 所属侧栏分组名（navRoutes 派生时已补默认值） */
  group: string
}

/** 未声明分组的带图标路由归入这个默认分组（分组只是展示归置，不影响可达性） */
export const DEFAULT_NAV_GROUP = '工作台'

/** 侧栏分组的展示顺序；声明了但不在清单内的分组排在其后（不丢失） */
export const NAV_GROUP_ORDER = ['工作台', 'WeLink', 'CodeHub', '系统'] as const

const routes: RouteRecordRaw[] = [
  {
    path: '/',
    name: 'dashboard',
    component: () => import('@/views/DashboardView.vue'),
    meta: { title: '工作台', icon: IconGrid, order: 10, group: '工作台' },
  },
  {
    path: '/table',
    name: 'table',
    component: () => import('@/views/TableCrudView.vue'),
    meta: { title: '数据管理', icon: IconTable, order: 20, group: '工作台' },
  },
  {
    path: '/welink',
    name: 'welink',
    component: () => import('@/views/WeLinkView.vue'),
    meta: { title: 'WeLink 助手', icon: IconActivity, order: 30, group: 'WeLink' },
  },
  {
    path: '/groups',
    name: 'groups',
    component: () => import('@/views/GroupView.vue'),
    meta: { title: '快速建群', icon: IconUsers, order: 35, group: 'WeLink' },
  },
  {
    path: '/codehub',
    name: 'codehub',
    component: () => import('@/views/CodehubReviewView.vue'),
    meta: { title: 'CodeHub 检视', icon: IconGitBranch, order: 40, group: 'CodeHub' },
  },
  {
    path: '/settings',
    name: 'settings',
    component: () => import('@/views/SettingsView.vue'),
    meta: { title: '配置', icon: IconSliders, order: 50, group: '系统' },
  },
  {
    path: '/envcheck',
    name: 'envcheck',
    component: () => import('@/views/EnvCheckView.vue'),
    meta: { title: '环境检测', icon: IconCircleCheck, order: 55, group: '系统' },
  },
  {
    path: '/about',
    name: 'about',
    component: () => import('@/views/AboutView.vue'),
    meta: { title: '关于', icon: IconInfo, order: 60, group: '系统' },
  },
  { path: '/:pathMatch(.*)*', redirect: '/', meta: { title: '工作台', hidden: true } },
]

/**
 * 从路由表派生侧栏导航项。
 *
 * 过滤规则：有 `icon`、未标 `hidden`。用「有没有图标」而不是单开一个 `nav:true`
 * 标记，是因为「有图标」与「想显示在侧栏」在本项目里本就是同一件事 —— 少一个
 * 需要同步的字段。`meta.title` 是所有路由的必填项（类型上强制），因此这里
 * 不需要防御性兜底。分组缺失时补默认分组（引入分组不得让任何路由从侧栏消失）。
 */
export function navRoutes(): NavItem[] {
  return routes
    .filter(
      (route): route is RouteRecordRaw & { meta: { title: string; icon: unknown } } =>
        Boolean(route.meta?.icon) && !route.meta?.hidden,
    )
    .map((route) => ({
      path: route.path,
      title: route.meta.title,
      icon: route.meta.icon,
      group: route.meta.group ?? DEFAULT_NAV_GROUP,
      order: route.meta.order ?? Number.MAX_SAFE_INTEGER,
    }))
    .sort((a, b) => a.order - b.order)
    .map(({ path, title, icon, group }) => ({ path, title, icon, group }))
}

/** 分组导航（MainLayout 渲染用）：组间按 NAV_GROUP_ORDER，组内沿用 order 排序 */
export function navGroups(): Array<{ name: string; items: NavItem[] }> {
  const grouped = new Map<string, NavItem[]>()
  for (const item of navRoutes()) {
    const bucket = grouped.get(item.group) ?? []
    bucket.push(item)
    grouped.set(item.group, bucket)
  }
  const known = NAV_GROUP_ORDER.filter((name) => grouped.has(name)).map((name) => ({ name, items: grouped.get(name)! }))
  const extra = [...grouped.keys()]
    .filter((name) => !(NAV_GROUP_ORDER as readonly string[]).includes(name))
    .map((name) => ({ name, items: grouped.get(name)! }))
  return [...known, ...extra]
}

const router = createRouter({
  // hash 模式：exe 内是本地文件协议，history 模式刷新会 404
  history: createWebHashHistory(),
  routes,
})

export default router
