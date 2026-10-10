<script setup lang="ts">
import { onMounted, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import zhCn from 'element-plus/es/locale/lang/zh-cn'

import { bridge } from '@/api'
import MainLayout from '@/layouts/MainLayout.vue'
import { useAppStore } from '@/stores/app'
import { useTableStore } from '@/stores/table'
import { useCodehubStore } from '@/stores/codehub'
import { useWelinkStore } from '@/stores/welink'
import { bindHostLink } from '@/stores/welink/host-link'
import { logger } from '@/utils/logger'

const route = useRoute()
const router = useRouter()
const appStore = useAppStore()
const tableStore = useTableStore()
const codehubStore = useCodehubStore()
const welinkStore = useWelinkStore()

/**
 * Element Plus 区域语言（P-1）。
 *
 * 为什么从 `main.ts` 搬到这里：原先挂在 `app.use(ElementPlus, { locale: zhCn })`
 * 上，而全量注册已被按需引入取代（见 `main.ts` 注释）。`ConfigProvider` 是
 * Element Plus 官方在按需引入场景下的 locale 注入方式 —— 少了它，分页
 * （`el-pagination`）与日期/时间选择器会显示英文。
 *
 * 作用域用 `ConfigProvider` 包住 `MainLayout`：`ElMessage` / `ElMessageBox`
 * 这类命令式 API 的 locale 由组件内的 `ConfigProvider` 上下文决定，
 * 因此必须在应用根部提供。
 */
const locale = zhCn

// —— 服务常驻：关窗策略下发（service-residency T-B）——
// 前端是唯一读 config 的人（Rust 不碰配置文件，T-L）。immediate 覆盖启动时序：
// 装配先于 load() 用默认 'tray' 兜底（用户立刻点 X 已受隐藏语义保护），配置
// 读完/改完都会再触发一次，无需重启即生效。
watch(
  () => appStore.settings.closeBehavior,
  (policy) => void bridge.traySetClosePolicy(policy ?? 'tray'),
  { immediate: true },
)

onMounted(async () => {
  await appStore.load()
  await tableStore.load()

  // 每页条数唯一真值在配置里，启动时向表格注入（表格侧只读消费）
  tableStore.pageSize = appStore.settings.pageSize

  const target = appStore.settings.defaultRoute
  if (target && target !== '/' && route.path === '/') {
    void router.replace(target)
  }

  // CodeHub 检视域的应用级装配：迁移 → 装载仓库清单 → 按配置起自动同步。
  // 周期轮询是后台职责，不该等用户走进检视页才开始（spec「轮询间隔生效」）；
  // 不 await —— 首屏不被子进程与磁盘IO 拖住（P6），失败由检视页呈现失败态与重试。
  void codehubStore.init()

  // —— WeLink 服务应用级装配（service-residency T-J，口径与上方 CodeHub 注释一致）——
  // 原 WeLinkView 的启动决策整体上移到这里：驻留的前提是「进程在」，而不是「进过页面」。
  // 不 await：迁移/装载不拖首屏；失败落日志（驻留期界面可能无人值守）。
  void welinkStore
    .init(appStore.settings.weLink)
    .then(({ panicRecovered }) => {
      if (panicRecovered) {
        // 急停跨重启不复活（评审 P1）：init 已强制人工确认模式并复位内存标记，
        // 这里把降级写回持久层（autoSave 落盘）并显式告知用户。
        appStore.settings.weLink = { ...welinkStore.settings, sendMode: 'manual', panicked: false }
        ElMessage.error('上次会话以「一键全停」结束：已降为人工确认模式，未自动恢复外发')
      }
      // 上次关程序时是开着的 → 直接恢复运行（会话级 cursor 从库恢复，只拉增量）
      if (welinkStore.settings.enabled) return welinkStore.start()
    })
    .catch((error) => logger.error('WeLink 服务装配失败', error))

  // 托盘事件 ↔ 服务生命周期联动（T-J/K）。退订函数有意丢弃：联动层与应用同生命周期
  // （onUnmounted 全应用仅退出时触发）。
  bindHostLink(welinkStore)
})

// 配置改动实时同步到表格分页，修复 keep-alive 后配置不生效的问题
watch(
  () => appStore.settings.pageSize,
  (size) => {
    tableStore.pageSize = size
  },
)
</script>

<template>
  <el-config-provider :locale="locale">
    <MainLayout />
  </el-config-provider>
</template>
