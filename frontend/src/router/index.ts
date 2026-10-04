import { createRouter, createWebHistory } from 'vue-router'

import Dashboard from '@/views/Dashboard.vue'
import ModulePage from '@/views/ModulePage.vue'
import { MODULES } from '@/data/modules'

// 业务模块页面结构一致，统一由 ModulePage 按路由 meta.moduleKey 渲染，
// 统计口径、停用联动与刷新行为在各页面保持同一份实现。
const moduleRoutes = MODULES.map((meta) => ({
  path: `/${meta.key}`,
  name: meta.key,
  component: ModulePage,
  meta: { moduleKey: meta.key },
}))

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', name: 'dashboard', component: Dashboard },
    ...moduleRoutes,
  ],
})

export default router
