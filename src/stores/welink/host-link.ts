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
import { logger } from '@/utils/logger'
import type { RuntimeStatus } from './aggregate'
import type { useWelinkStore } from './index'

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

  // ③ 窗口唤回兜底：视口可见性上报链路只在 WeLink 页激活时绑定（bindPageEffects），
  //    驻留期从别的页面唤回时 document.visibilityState 可能仍是缓存的 hidden —— 以宿主
  //    事件为准强制复位，避免恢复后仍按 ×3 降频跑（poller.setVisible 幂等，重复设置无害）。
  void bridge
    .onHostEvent('host://window-shown', () => store.setPageVisible(true))
    .then((unlisten) => (disposed ? unlisten() : unsubs.push(unlisten)))

  // host://window-hidden 无需处理：页面可见性降载由 bindPageEffects 的
  // visibilitychange 负责（occlusion 禁用下隐藏不再触发 hidden 分支，T-G 对策 1）。

  return () => {
    disposed = true
    for (const unlisten of unsubs) unlisten()
    unsubs.length = 0
  }
}
