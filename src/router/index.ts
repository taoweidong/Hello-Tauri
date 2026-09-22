import { createRouter, createWebHashHistory } from 'vue-router'

const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    {
      path: '/',
      name: 'dashboard',
      component: () => import('@/views/DashboardView.vue'),
      meta: { title: '概览' },
    },
    {
      path: '/table',
      name: 'table',
      component: () => import('@/views/TableCrudView.vue'),
      meta: { title: '数据管理' },
    },
    {
      path: '/settings',
      name: 'settings',
      component: () => import('@/views/SettingsView.vue'),
      meta: { title: '配置' },
    },
    {
      path: '/about',
      name: 'about',
      component: () => import('@/views/AboutView.vue'),
      meta: { title: '关于' },
    },
    { path: '/:pathMatch(.*)*', redirect: '/' },
  ],
})

export default router
