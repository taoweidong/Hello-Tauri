/**
 * 自动更新 store（design-auto-update §11.5）：编排层与 UI 之间唯一的状态层。
 *
 * 组合点（AGENTS D2 装配例外口径）：本 store 消费 infra/update 工厂做装配
 * （浏览器模式自动 mock），业务规则仍在 orchestrator/update。
 *
 * 装配说明：
 *  * `init()` 在 App.vue onMounted（appStore.load 之后）调用一次 —— 更新编排
 *    依赖 appInfo 的版本号，且随应用全生命周期驻留（调度器与应用同生命周期）；
 *  * pauseServices 注入 welink/codehub 的停服动作（U-J：apply 前停在飞任务，
 *    重启后由各域 bootstrap 恢复），store 之间单向依赖，无环。
 */
import { computed, ref } from 'vue'
import { defineStore } from 'pinia'

import { bridge } from '@/api'
import { updateClient } from '@/infra/update'
import { createUpdater, emptyStatus, type Updater, type UpdatePersistedState, type UpdateStatus } from '@/orchestrator/update'
import { realTimers } from '@/orchestrator/timers'
import { useAppStore } from '@/stores/app'
import { useCodehubStore } from '@/stores/codehub'
import { useWelinkStore } from '@/stores/welink'
import { normalizeUpdateSettings } from '@/types/update'
import { logger } from '@/utils/logger'

export const useUpdateStore = defineStore('update', () => {
  const appStore = useAppStore()
  const status = ref<UpdateStatus>({ ...emptyStatus() })
  const updaterHolder: { current: Updater | null } = { current: null }

  /** 是否有可安装的更新（工作台小红点与设置卡共用的聚合口径） */
  const hasUpdate = computed(() => {
    if (!normalizeUpdateSettings(appStore.settings.update).enabled) return false
    return status.value.state === 'available' || status.value.state === 'ready' || Boolean(status.value.hintVersion)
  })

  /** 更新流转中（检查/下载/安装），按钮态的依据 */
  const busy = computed(() =>
    ['checking', 'downloading', 'verifying', 'applying'].includes(status.value.state),
  )

  function ensureUpdater(): Updater {
    if (updaterHolder.current) return updaterHolder.current
    const updater = createUpdater({
      client: updateClient(),
      settings: () => normalizeUpdateSettings(appStore.settings.update),
      currentVersion: appStore.info?.version ?? __APP_VERSION__,
      // U-J：apply 前停服务。WeLink 轮询/管线/沉淀全链停（运行中才停），
      // CodeHub 停自动同步；各自重启后由 bootstrap/applyAutoSettings 恢复。
      pauseServices: async () => {
        const welinkStore = useWelinkStore()
        if (welinkStore.runtimeRunning()) welinkStore.stop()
        useCodehubStore().stopAuto()
      },
      notify: (title, body) => {
        void bridge.notifySend(title, body)
      },
      loadState: async (): Promise<UpdatePersistedState | null> => {
        const raw = await bridge.fsRead('update/state.json')
        if (!raw) return null
        try {
          return JSON.parse(raw) as UpdatePersistedState
        } catch {
          return null
        }
      },
      saveState: async (state) => {
        await bridge.fsWrite('update/state.json', JSON.stringify(state, null, 2))
      },
      timers: realTimers,
    })
    updater.onStatus((next) => {
      status.value = next
    })
    status.value = updater.getStatus()
    updaterHolder.current = updater
    return updater
  }

  /** 应用级装配（幂等）：恢复提示 + 启动延迟检查 + 周期对表 + 摆渡扫描 */
  function init(): void {
    try {
      ensureUpdater().init()
    } catch (error) {
      logger.warn('更新编排装配失败（更新功能本次会话不可用）', error)
    }
  }

  /** 手动检查（绕过节流）；失败态由卡片呈现 */
  async function checkNow(): Promise<void> {
    await ensureUpdater().checkNow('manual')
  }

  /** 下载并安装（notify 模式用户点按；inbox 命中时直接进入安装） */
  async function install(): Promise<void> {
    await ensureUpdater().install()
  }

  /** 扫描摆渡目录（update/inbox/，设置卡按钮） */
  async function scanInbox(): Promise<void> {
    await ensureUpdater().scanInbox()
  }

  return {
    status,
    hasUpdate,
    busy,
    init,
    checkNow,
    install,
    scanInbox,
  }
})
