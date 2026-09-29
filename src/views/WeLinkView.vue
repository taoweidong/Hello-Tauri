<script setup lang="ts">
/**
 * WeLink × Agent 自动回复助手 —— 主视图（设计 §11）。
 *
 * 结构 = **顶部全局控制条（常驻，跨 Tab）** + **五 Tab 主区**。
 *
 * 三条实现约定：
 *  * 配置类操作全部在 SettingsView 的「WeLink 助手」卡片，本页只管**运行时**
 *    （开关、急停、熔断、待审、拉取）—— 两处都能改配置必然出现「改了没生效」。
 *  * Tab 懒加载（O4）：只有激活的 Tab 挂载并发查询，避免首屏五个 Tab 齐发。
 *  * 长文本一律「折叠 + 展开 + 复制」（§11.7）。
 */
import { computed, onActivated, onDeactivated, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'

import { IconActivity } from '@/components/icons'
import { useAppStore } from '@/stores/app'
import { subscribeWelinkLogs, unsubscribeWelinkLogs, useWelinkStore } from '@/stores/welink'
import ControlBar from '@/components/welink/ControlBar.vue'
import MessagesTab from '@/components/welink/MessagesTab.vue'
import InboxTab from '@/components/welink/InboxTab.vue'
import HistoryTab from '@/components/welink/HistoryTab.vue'
import TraceTab from '@/components/welink/TraceTab.vue'
import ConfigTab from '@/components/welink/ConfigTab.vue'
import WizardPanel from '@/components/welink/WizardPanel.vue'

const appStore = useAppStore()
const store = useWelinkStore()
const router = useRouter()

type TabKey = 'messages' | 'inbox' | 'history' | 'trace' | 'config'

const TABS: Array<{ key: TabKey; label: string; hint: string }> = [
  { key: 'messages', label: '消息中心', hint: '要点 1/2：群 @我 与私聊消息的存档与回复' },
  { key: 'inbox', label: '私聊收件箱', hint: 'R2：私聊双向存档，按联系人分组' },
  { key: 'history', label: '回复历史', hint: 'R3：任务全生命周期与拦截审计' },
  { key: 'trace', label: 'Agent 回溯', hint: 'R4：模型输入输出语料，差评对即改进素材' },
  { key: 'config', label: '监控配置', hint: 'R1：监控（存档）与自动回复（外发）分别控制' },
]

const activeTab = ref<TabKey>('messages')

// —— 跨 Tab 跳转（O7 待审徽标 / 熔断横幅 / 右侧栏「查看回复历史」） ——
const historyPreset = ref<{ onlyHolding?: boolean; onlySkipped?: boolean; targetId?: string } | null>(null)
const focusConvId = ref('')
const focusJobPk = ref<number | null>(null)

function openHistory(preset: { onlyHolding?: boolean; onlySkipped?: boolean; targetId?: string }) {
  historyPreset.value = preset
  activeTab.value = 'history'
}

/** R4 联动：从回复历史跳 Agent 回溯，并定位到该任务 */
function openTrace(jobPk: number) {
  focusJobPk.value = jobPk
  activeTab.value = 'trace'
}

async function goSettings() {
  wizardOpen.value = false
  await router.push('/settings')
}

/**
 * 工号兜底熔断 → 定位到工号输入框所在处。
 *
 * 工号字段在**本页「配置」Tab** 的 SettingsCard 里（不是全局 /settings 页），
 * 因此就近切 Tab 即可，不必跨页跳转 —— 用户点了「去填写工号」却跳到另一个
 * 页面、还得自己找回来，是最容易让人放弃的路径（O8 的初衷正是「把静默拒绝
 * 变成显式指引」）。
 */
function goUserIdField() {
  activeTab.value = 'config'
}

// —— 首次引导（O8）：enabled=off 且未配置过时自动展开三步卡片 ——
const wizardOpen = ref(false)
const needWizard = computed(
  () =>
    !store.settings.enabled &&
    store.conversations.length === 0 &&
    !store.settings.myUserId.trim() &&
    store.status !== 'init',
)

// —— 控制条动作 ——

async function toggleEnabled(value: boolean) {
  store.applySettings({ ...store.settings, enabled: value })
  // 以热副本为基底写回持久层（评审 F-3 三副本漂移）：用 appStore 旧值做基底，
  // 会把设置卡片已热更新但未「保存配置」的编辑覆盖回旧值，重启后静默丢失
  appStore.settings.weLink = { ...store.settings, enabled: value }
  if (value) {
    const report = await store.start()
    ElMessage.success(report ? '助手已启动' : '助手启动异常，请查看日志')
  } else {
    store.stop()
    ElMessage.info('助手已暂停，数据与未完成任务保留')
  }
}

async function onPanicStop() {
  if (store.status === 'panic') {
    const confirmed = await ElMessageBox.confirm(
      '解除后自动回复将默认降为「人工确认」模式缓冲，避免积压任务瞬间涌出。确认解除？',
      '解除一键全停',
      { type: 'warning', confirmButtonText: '解除', cancelButtonText: '取消' },
    ).catch(() => false)
    if (confirmed === false) return
    store.liftPanic()
    // 解除后的降级必须写回配置，否则下次启动又回到 auto；急停标记一并复位。
    // 以热副本为基底写回，避免把持久层旧值盖回去（评审 F-3 三副本漂移）。
    appStore.settings.weLink = { ...store.settings, sendMode: 'manual', panicked: false }
    ElMessage.warning('已解除急停：发送模式已降为「人工确认」')
    return
  }
  store.panicStop()
  // 急停标记落盘（评审 P1）：重启后 init 读到它强制转人工，外发不会静默恢复。
  // 以热副本为基底写回，避免把持久层旧值盖回去（评审 F-3 三副本漂移）。
  appStore.settings.weLink = { ...store.settings, panicked: true }
  ElMessage.error('已触发一键全停：所有外发被阻断')
}

async function doPullNow() {
  if (!store.settings.enabled) {
    ElMessage.warning('助手未启动：请先打开总开关')
    return
  }
  const summary = await store.pullNow()
  ElMessage.success(
    `新增 ${summary.inserted} 条、命中 ${summary.jobs} 条待回复（已拉取 ${summary.polled}/${summary.conversations} 个会话` +
      (summary.failed ? `，失败 ${summary.failed} 个` : '') +
      '）',
  )
}

async function refreshAll() {
  await store.loadConversations()
  await store.refreshReviewCount()
  await store.refreshSafety()
  ElMessage.success('已刷新')
}

async function playDemo() {
  const ok = await store.playDemoScript()
  ElMessage[ok ? 'success' : 'warning'](ok ? '演示剧本已回放，请查看消息中心与回复历史' : '当前数据源不支持演示剧本')
}

// —— 生命周期 ——

/**
 * MainLayout 用**无 include 的 keep-alive** 包住所有路由组件：正常导航只触发
 * onActivated/onDeactivated，onUnmounted 在应用整个生命周期内都不会发生。
 * 曾把清理挂在 onUnmounted（D-9 v1）—— 在 keep-alive 下是永不执行的死代码。
 *
 * 因此这里的绑定/解绑必须：① 成对挂在 activated/deactivated（卸载兜底）；
 * ② 幂等（首次进入 = mounted → activated 连发，绑一次）；③ 把日志旁路订阅
 * 纳入绑定集 —— deactivated 退订后，复活路径必须能重建订阅。
 */

let visibilityHandler: (() => void) | null = null

function bindPageEffects(): void {
  if (visibilityHandler) return
  // P9：窗口不可见时降载（隐藏 ×3）。此处只做「告知编排层」，
  // 真正的降载逻辑在 poller.setVisible —— 视图不持有计时器。
  visibilityHandler = () => {
    store.setPageVisible(document.visibilityState !== 'hidden')
  }
  document.addEventListener('visibilitychange', visibilityHandler)
  subscribeWelinkLogs()
}

function unbindPageEffects(): void {
  if (!visibilityHandler) return
  document.removeEventListener('visibilitychange', visibilityHandler)
  visibilityHandler = null
  /**
   * D-9：退订编排层日志旁路。退订后 **不** 清 `store.logs` ——
   * 日志是诊断信息，回到页面应还能看到。
   */
  unsubscribeWelinkLogs()
}

onMounted(async () => {
  const { panicRecovered } = await store.init(appStore.settings.weLink)
  if (panicRecovered) {
    // 急停跨重启不复活（评审 P1）：init 已强制人工确认模式并复位内存标记，
    // 这里把降级写回持久层（autoSave 落盘）并显式告知用户。
    appStore.settings.weLink = { ...store.settings, sendMode: 'manual', panicked: false }
    ElMessage.error('上次会话以「一键全停」结束：已降为人工确认模式，未自动恢复外发')
  }
  // 上次关程序时是开着的 → 直接恢复运行（会话级 cursor 从库恢复，只拉增量）
  if (store.settings.enabled) await store.start()
  bindPageEffects()
})

onActivated(bindPageEffects)
onDeactivated(unbindPageEffects)
onUnmounted(unbindPageEffects)

// Tab 懒加载：切换时才触发该 Tab 的查询（O4）
watch(activeTab, (tab) => {
  if (tab === 'config') void store.loadConversations()
})

watch(
  () => store.reviewCount,
  (next, prev) => {
    if (next > prev && prev >= 0) ElMessage.info(`新增 ${next - prev} 条待审回复，点击「待审」查看`)
  },
)
</script>

<template>
  <div class="page welink">
    <!-- 页面标题 + 来源徽标 -->
    <div class="page-title">
      <h1>WeLink 助手</h1>
      <span class="caption">群/私聊消息自动回复 · 全链路留痕 · 防滥发闸口</span>
      <span class="spacer" />
      <el-tag :type="store.sourceBadge.mock ? 'warning' : 'success'" size="small" effect="plain" round>
        welink={{ store.sourceBadge.welink }} · agent={{ store.sourceBadge.agent }}
      </el-tag>
      <el-tag v-if="store.sourceBadge.mock" size="small" type="warning" effect="light" round>模拟数据</el-tag>
      <el-button v-if="needWizard && !wizardOpen" size="small" type="primary" plain @click="wizardOpen = true"
        >开始引导</el-button
      >
    </div>

    <!-- myUserId 缺失红条（O8：把熔断的静默拒绝变成显式指引） -->
    <el-alert
      v-if="!store.settings.myUserId.trim()"
      type="error"
      :closable="false"
      show-icon
      title="未填写工号，助手不会回复"
      description="工号用于过滤你自己发出的消息（防自回复循环）。未填写时 SafetyGate 会熔断兜底，所有自动外发都会被拦下。"
    />

    <!-- 全局控制条（§11.0） -->
    <ControlBar
      @toggle-enabled="toggleEnabled"
      @panic="onPanicStop"
      @pull-now="doPullNow"
      @refresh="refreshAll"
      @play-demo="playDemo"
      @open-review="openHistory({ onlyHolding: true })"
      @open-skipped="openHistory({ onlySkipped: true })"
      @open-settings="goUserIdField"
    />

    <!-- 首次引导（O8） -->
    <WizardPanel v-if="wizardOpen && needWizard" @done="wizardOpen = false" @go-settings="goSettings" />

    <!-- 运行日志（内存环形缓冲，P10：最多 200 行） -->
    <el-collapse v-if="store.logs.length" class="logbox">
      <el-collapse-item :title="`运行日志（${store.logs.length} 行，仅内存保留）`" name="logs">
        <div class="logbox__list">
          <div v-for="(line, index) in store.logs" :key="index" class="logbox__line" :class="`is-${line.level}`">
            <span class="logbox__at">{{ line.at }}</span>
            <span class="logbox__text">{{ line.text }}</span>
          </div>
        </div>
      </el-collapse-item>
    </el-collapse>

    <!-- 五 Tab 主区 -->
    <section class="ht-card tabs">
      <header class="tabs__head">
        <button
          v-for="tab in TABS"
          :key="tab.key"
          class="tabs__btn pressable"
          :class="{ 'is-active': activeTab === tab.key }"
          :title="tab.hint"
          @click="activeTab = tab.key"
        >
          {{ tab.label }}
          <span v-if="tab.key === 'messages' && store.unreadTotal" class="tabs__badge">{{ store.unreadTotal }}</span>
        </button>
        <span class="spacer" />
        <span class="tabs__hint">{{ TABS.find((item) => item.key === activeTab)?.hint }}</span>
      </header>

      <div class="tabs__body">
        <!-- ① 消息中心（要点1/2） -->
        <MessagesTab
          v-if="activeTab === 'messages'"
          :focus-conv-id="focusConvId"
          @open-history="openHistory"
          @manage="activeTab = 'config'"
        />
        <!-- ② 私聊收件箱（R2） -->
        <InboxTab
          v-else-if="activeTab === 'inbox'"
          @open-conversation="
            (id) => {
              focusConvId = id
              activeTab = 'messages'
            }
          "
        />
        <!-- ③ 回复历史（R3） -->
        <HistoryTab
          v-else-if="activeTab === 'history'"
          :preset="historyPreset"
          @preset-consumed="historyPreset = null"
          @open-trace="openTrace"
        />
        <!-- ④ Agent 回溯（R4） -->
        <TraceTab v-else-if="activeTab === 'trace'" :focus-job-pk="focusJobPk" @focus-consumed="focusJobPk = null" />
        <!-- ⑤ 监控配置（R1） -->
        <ConfigTab v-else />
      </div>
    </section>

    <!-- 演示剧本浮动按钮（O13，仅 mock 数据源可用） -->
    <button
      v-if="store.settings.welinkSource === 'mock'"
      class="demo-fab pressable"
      title="回放演示剧本：新人群聊 @我 → 私聊追问 → 对方回应"
      @click="playDemo"
    >
      <IconActivity class="demo-fab__icon" />
      演示剧本
    </button>

    <!-- 无会话时的引导遮罩（O8：空态不是死路，给一条明确的下一步） -->
    <div v-if="!store.conversations.length && !needWizard && store.status !== 'init'" class="empty-tip">
      <p>还没有任何会话配置。</p>
      <p class="empty-tip__sub">去「监控配置」点「同步会话」导入候选，或开启演示剧本快速体验。</p>
      <div class="empty-tip__actions">
        <el-button size="small" type="primary" plain @click="activeTab = 'config'">去监控配置</el-button>
        <el-button v-if="store.settings.welinkSource === 'mock'" size="small" @click="playDemo">回放演示剧本</el-button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.welink {
  position: relative;
}

.spacer {
  flex: 1;
}

.page-title .spacer {
  flex: 1;
}

.tabs {
  display: flex;
  flex-direction: column;
  min-height: 0;
}

.tabs__head {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--ht-line);
}

.tabs__btn {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  border: none;
  background: transparent;
  color: var(--ht-text-2);
  font: inherit;
  font-size: 13px;
  padding: 6px 12px;
  border-radius: var(--ht-radius-sm);
  cursor: pointer;
}

.tabs__btn:hover {
  color: var(--ht-text-1);
  background: var(--ht-surface-2);
}

.tabs__btn.is-active {
  color: var(--ht-primary);
  background: var(--ht-primary-soft);
  font-weight: 600;
}

.tabs__btn:focus-visible {
  outline: 2px solid var(--ht-primary);
  outline-offset: -1px;
}

.tabs__badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 17px;
  height: 17px;
  padding: 0 5px;
  border-radius: 9px;
  background: var(--ht-danger);
  color: #fff;
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}

.tabs__hint {
  font-size: 11.5px;
  color: var(--ht-text-3);
  padding-right: 4px;
}

.tabs__body {
  min-height: 420px;
  max-height: calc(100vh - 320px);
  overflow: auto;
}

.logbox {
  background: var(--ht-surface);
  border: 1px solid var(--ht-line);
  border-radius: var(--ht-radius);
  padding: 0 14px;
}

.logbox :deep(.el-collapse-item__header) {
  font-size: 12.5px;
  color: var(--ht-text-2);
  height: 38px;
  border-bottom: none;
}

.logbox :deep(.el-collapse-item__wrap) {
  border-bottom: none;
}

.logbox__list {
  max-height: 200px;
  overflow: auto;
  padding-bottom: 10px;
}

.logbox__line {
  display: flex;
  gap: 10px;
  font-size: 12px;
  line-height: 1.7;
  font-variant-numeric: tabular-nums;
}

.logbox__at {
  color: var(--ht-text-3);
  flex-shrink: 0;
}

.logbox__line.is-warn .logbox__text {
  color: var(--ht-warn);
}

.logbox__line.is-error .logbox__text {
  color: var(--ht-danger);
}

.logbox__text {
  color: var(--ht-text-2);
  overflow-wrap: anywhere;
}

.demo-fab {
  position: fixed;
  right: 22px;
  bottom: 20px;
  display: inline-flex;
  align-items: center;
  gap: 7px;
  padding: 9px 15px;
  border: 1px solid var(--ht-primary-line);
  border-radius: 20px;
  background: var(--ht-surface);
  color: var(--ht-primary);
  font: inherit;
  font-size: 12.5px;
  font-weight: 600;
  cursor: pointer;
  box-shadow: 0 6px 18px rgb(27 32 48 / 0.12);
}

.demo-fab:hover {
  background: var(--ht-primary-soft);
}

.demo-fab__icon {
  width: 15px;
  height: 15px;
}

.empty-tip {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding: 30px 16px;
  border: 1px dashed var(--ht-line-strong);
  border-radius: var(--ht-radius);
  background: var(--ht-surface);
}

.empty-tip p {
  margin: 0;
  font-size: 12.5px;
  color: var(--ht-text-2);
}

.empty-tip__sub {
  font-size: 11.5px !important;
  color: var(--ht-text-3) !important;
}

.empty-tip__actions {
  display: flex;
  gap: 8px;
  margin-top: 6px;
}
</style>
