/**
 * 宿主联动层（service-residency §3.1 / §9.3）：托盘事件 ↔ 服务生命周期 ↔ 托盘状态显示。
 *
 * 组合点放 store 层（AGENTS D2 装配例外口径）；启停动作仍是 control 的既有方法，
 * 业务规则继续留 orchestrator —— 本层只做翻译与回显，零新语义。
 *
 * 生命周期：App.vue onMounted 装配一次，与应用同生命周期（退订函数有意丢弃）。
 * 驻留期用户可能不在界面上，状态迁移除回写托盘外必须落盘日志（设计 §13.7）——
 * `logger` 是唯一落盘出口，恢复窗口后以 store 状态灯/横幅呈现（fuseBanner 先例）。
 */
import { watch } from 'vue'

import { bridge } from '@/api'
import { useAppStore } from '@/stores/app'
import { logger } from '@/utils/logger'
import type { RuntimeStatus } from './aggregate'
import type { useWelinkStore } from './index'

/** 托盘健康度巡检间隔：Rust 守护线程结论的变化节奏是秒~十秒级，分钟级足够 */
const TRAY_HEALTH_INTERVAL_MS = 60_000

type WelinkStore = ReturnType<typeof useWelinkStore>

/** 状态灯 → 托盘 tooltip 文案（T-K：单一真值 store.status） */
const STATUS_TEXT: Record<RuntimeStatus, string> = {
  idle: '未启动',
  init: '初始化中',
  running: '服务运行中',
  backoff: '退避重试中',
  stopped: '服务已停止',
  panic: '急停（人工确认模式）',
}

export function bindHostLink(store: WelinkStore): () => void {
  const unsubs: Array<() => void> = []
  let disposed = false

  // ① 状态回显：任何路径的状态迁移（UI 启停/托盘暂停/急停/熔断）都同步到托盘；
  //    同时落盘日志 —— 驻留期无 UI，日志是唯一观察窗（§13.7）。
  unsubs.push(
    watch(
      () => store.status,
      (status, prev) => {
        void bridge.traySetStatus(store.runtimeRunning(), STATUS_TEXT[status] ?? 'Hello-Tauri')
        if (prev !== undefined && prev !== status) {
          logger.info(`服务状态：${STATUS_TEXT[prev] ?? prev} → ${STATUS_TEXT[status] ?? status}`)
        }
      },
      { immediate: true },
    ),
  )

  // ② 托盘「暂停服务/恢复服务」：一个菜单项两种语义，判据只有 runtimeRunning()。
  //    恢复 = store.start()：走完整 bootstrap 三分支恢复（挂起态复核、cursor 增量），
  //    不是「裸续跑」——语义与助手页手动重启严格一致（settings.enabled=false 时
  //    start() 内部不拉起 poller，与页面行为一致；急停降级同样被尊重）。
  void bridge
    .onHostEvent('host://tray-toggle', () => {
      if (store.runtimeRunning()) {
        store.stop() // 停生产再停消费的内部顺序由 runtime.stop 保证
      } else {
        void store.start()
      }
    })
    .then((unlisten) => (disposed ? unlisten() : unsubs.push(unlisten)))

  // ③ 窗口显隐联动：
  //    - hidden：落盘日志 —— 驻留期无 UI，「何时收进托盘」是事后诊断的锚点（§13.7）。
  //    - shown：视口可见性上报链路只在 WeLink 页激活时绑定（bindPageEffects），
  //      驻留期从别的页面唤回时 document.visibilityState 可能仍是缓存的 hidden ——
  //      以宿主事件为准强制复位，避免恢复后仍按 ×3 降频跑（poller.setVisible 幂等）。
  void bridge
    .onHostEvent('host://window-hidden', () => logger.info('界面已收进系统托盘，服务继续后台运行'))
    .then((unlisten) => (disposed ? unlisten() : unsubs.push(unlisten)))
  void bridge
    .onHostEvent('host://window-shown', () => {
      logger.info('界面已从系统托盘恢复')
      store.setPageVisible(true)
      // 唤回是用户「看见界面」的时刻：托盘健康度若有变化（驻留期被拦截/恢复），
      // 此刻刷新才能让告警/设置页状态与 Rust 守护线程结论对齐（T-O）
      void useAppStore().refreshTrayHealth()
    })
    .then((unlisten) => (disposed ? unlisten() : unsubs.push(unlisten)))

  // ④ 托盘健康度巡检（T-O）：tray-icon crate 静默吞 NIM_ADD 失败，「build 成功」
  //    不等于「图标存在」——Rust 守护线程对账 explorer 的结论经 tray_health 上报，
  //    本层只负责按节奏取回 appStore；state=2 的可见告警在 App.vue（一次性）。
  const appStore = useAppStore()
  void appStore.refreshTrayHealth()
  const healthTimer = setInterval(() => void appStore.refreshTrayHealth(), TRAY_HEALTH_INTERVAL_MS)
  unsubs.push(() => clearInterval(healthTimer))

  return () => {
    disposed = true
    for (const unlisten of unsubs) unlisten()
    unsubs.length = 0
  }
}
