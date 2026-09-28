<script setup lang="ts">
/**
 * 全局控制条（设计 §11.0）—— 常驻页面顶部，跨 Tab。
 *
 * 这一条承载了「运行时」的全部手工干预入口：
 *  总开关 / 一键全停（L0）/ 熔断横幅（S8）/ 运行状态灯 / 配额徽标 /
 *  来源徽标 / 立即拉取 / 待审徽标（O7）/ myUserId 红条。
 *
 * 设计原则：**只读展示 + 少数几个动作按钮**，所有参数配置在 Settings 页 ——
 * 把「看一眼状态」的成本压到最低，同时让危险动作（急停/解除熔断）触手可及。
 */
import { computed } from 'vue'

import { IconAlert, IconClock, IconRefresh } from '@/components/icons'
import { useWelinkStore } from '@/stores/welink'

const store = useWelinkStore()

const emit = defineEmits<{
  (e: 'toggle-enabled', value: boolean): void
  (e: 'panic'): void
  (e: 'pull-now'): void
  (e: 'refresh'): void
  (e: 'play-demo'): void
  (e: 'open-review'): void
  /** 熔断横幅 → 回复历史「仅看被拦截」，审计本窗被拦下的每一条 */
  (e: 'open-skipped'): void
  /** 工号兜底熔断 → 跳到设置页补工号（这是该熔断唯一的解除方式） */
  (e: 'open-settings'): void
}>()

const enabled = computed({
  get: () => store.settings.enabled,
  set: (value: boolean) => emit('toggle-enabled', value),
})

const statusTone = computed(() => `is-${store.status}`)

/** 各会话退避明细（状态灯 tooltip） */
const backoffDetail = computed(() => {
  const items = Object.entries(store.convoStates).filter(([, state]) => state.state === 'backoff')
  if (!items.length) return '所有会话拉取正常'
  return items
    .map(([convId, state]) => `${convId}：失败 ${state.failCount} 次，退避 ${state.backoffSec}s（${state.reason}）`)
    .join('\n')
})

/** S2 各会话冷却明细（配额徽标 hover） */
const quotaDetail = computed(() => {
  const entries = Object.entries(store.safety.convCounts).filter(([, count]) => count > 0)
  if (!entries.length) return '本小时尚无自动回复'
  return entries.map(([convId, count]) => `${convId}：${count}/${store.settings.safety.perConvHourlyCap}`).join('\n')
})

const fuseText = computed(() => {
  const banner = store.fuseBanner
  if (!banner) return ''
  const blocked = banner.blocked ? `，本窗拦截 ${banner.blocked} 条` : ''
  return `${banner.scope}场景滥发风险已熔断暂停${blocked}（原因：${banner.reason}）`
})

/**
 * 工号兜底熔断（S8）与「阈值类」熔断（拦截次数超阈值）**语义不同**：
 *
 *  * 阈值类：成因是「刚才拦得太多」，人工确认没问题后点「解除熔断」即可恢复；
 *  * 工号兜底：成因是「工号没填」，此时自发消息过滤（filterSelf）是失效的 ——
 *    若允许人工解除，助手会把自己的回复当成新消息回，形成**自回复死循环**
 *    （设计 §637）。唯一解除方式是去设置页补齐工号。
 *
 * 因此这里不给兜底熔断渲染「解除熔断」按钮，而是给一个直达设置页的引导 ——
 * 让用户点一个按了也没用的按钮是最差的交互。
 */
const isUserIdFuse = computed(() => store.fuseBanner?.scope === '全局' || store.safety.globalFuse)

function liftFuse() {
  const banner = store.fuseBanner
  if (!banner) return
  // 只解除「阈值类」；'global' 会走到工号兜底分支，那里刻意不解（见 safety-gate 的 resetFuse）
  if (isUserIdFuse.value) return
  store.resetFuse(banner.scope === '全局' ? 'global' : undefined)
}
</script>

<template>
  <div class="bar ht-card">
    <!-- 总开关 + 状态灯 -->
    <div class="bar__group">
      <el-switch
        v-model="enabled"
        :disabled="store.status === 'panic'"
        inline-prompt
        active-text="开"
        inactive-text="关"
      />
      <span class="bar__status" :class="statusTone">
        <span class="bar__dot" aria-hidden="true" />
        {{ store.statusText }}
      </span>
    </div>

    <div class="bar__sep" />

    <!-- 一键全停（L0） -->
    <el-tooltip
      :content="store.status === 'panic' ? '解除急停（会先降为人工确认模式）' : '立即停止轮询与外发，封死所有自动发送'"
      placement="bottom"
    >
      <button class="bar__panic pressable" :class="{ 'is-on': store.status === 'panic' }" @click="emit('panic')">
        <IconAlert class="bar__panic-icon" />
        {{ store.status === 'panic' ? '解除急停' : '一键全停' }}
      </button>
    </el-tooltip>

    <div class="bar__sep" />

    <!-- 配额徽标（S3） -->
    <el-tooltip :content="quotaDetail" placement="bottom">
      <span class="bar__quota">
        <IconClock class="bar__mini" />
        {{ store.quotaText }}
      </span>
    </el-tooltip>

    <!-- 待审徽标（O7） -->
    <button
      class="bar__review pressable"
      :class="{ 'is-active': store.reviewCount > 0 }"
      :title="store.reviewCount > 0 ? '有待审回复，点击查看' : '暂无待审'"
      @click="emit('open-review')"
    >
      待审 {{ store.reviewCount }}
    </button>

    <span class="bar__spacer" />

    <!-- 拉取摘要 -->
    <span v-if="store.pullSummary.polled" class="bar__summary num">
      本轮 +{{ store.pullSummary.inserted }} 条 · {{ store.pullSummary.jobs }} 待回
    </span>

    <!-- 动作。placement 必须用 popper 的合法取值 `bottom-start`（左对齐下沉）；
         原先写的 `bottom-left` 不在 Placement 联合类型里，运行期会被忽略并回退默认定位。 -->
    <el-tooltip :content="backoffDetail" placement="bottom-start">
      <el-button size="small" :icon="IconRefresh" :loading="store.pulling" @click="emit('pull-now')"
        >立即拉取</el-button
      >
    </el-tooltip>
    <el-button size="small" text @click="emit('refresh')">刷新</el-button>
  </div>

  <!-- 熔断横幅（S8）—— 两类熔断给不同的出口：
       阈值类点「解除熔断」，工号兜底点「去填写工号」（前者按了有用，后者按了没用）。 -->
  <div v-if="store.fuseBanner || store.hasFuse" class="fuse">
    <IconAlert class="fuse__icon" />
    <span class="fuse__text">{{ fuseText || '存在熔断中的场景，自动回复已暂停' }}</span>
    <span class="fuse__spacer" />
    <el-button v-if="isUserIdFuse" size="small" type="danger" plain @click="emit('open-settings')">
      去填写工号
    </el-button>
    <el-button v-else size="small" type="warning" plain @click="liftFuse">解除熔断</el-button>
    <el-button size="small" text @click="emit('open-skipped')">查看被拦记录</el-button>
  </div>
</template>

<style scoped>
.bar {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 14px;
  flex-wrap: wrap;
}

.bar__group {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-shrink: 0;
}

.bar__status {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12.5px;
  font-weight: 600;
  color: var(--ht-text-2);
}

.bar__dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--ht-text-3);
  flex-shrink: 0;
}

.bar__status.is-running .bar__dot {
  background: var(--ht-ok);
}

.bar__status.is-backoff .bar__dot {
  background: var(--ht-warn);
  animation: ht-pulse 1.4s ease-in-out infinite;
}

.bar__status.is-panic .bar__dot {
  background: var(--ht-danger);
}

.bar__status.is-init .bar__dot {
  background: var(--ht-primary);
  animation: ht-pulse 1.4s ease-in-out infinite;
}

.bar__status.is-panic {
  color: var(--ht-danger);
}

.bar__sep {
  width: 1px;
  height: 18px;
  background: var(--ht-line);
  flex-shrink: 0;
}

.bar__panic {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 5px 12px;
  border: 1px solid var(--ht-danger);
  border-radius: var(--ht-radius-sm);
  background: transparent;
  color: var(--ht-danger);
  font: inherit;
  font-size: 12.5px;
  font-weight: 600;
  cursor: pointer;
}

.bar__panic:hover {
  background: var(--el-color-danger-light-9);
}

.bar__panic.is-on {
  background: var(--ht-danger);
  color: #fff;
}

.bar__panic-icon {
  width: 14px;
  height: 14px;
}

.bar__quota {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 12px;
  color: var(--ht-text-2);
  font-variant-numeric: tabular-nums;
  cursor: default;
}

.bar__mini {
  width: 13px;
  height: 13px;
  color: var(--ht-text-3);
}

.bar__review {
  position: relative;
  padding: 4px 11px;
  border: 1px solid var(--ht-line);
  border-radius: var(--ht-radius-sm);
  background: var(--ht-surface);
  color: var(--ht-text-2);
  font: inherit;
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  cursor: pointer;
}

.bar__review.is-active {
  border-color: var(--ht-warn);
  color: var(--ht-warn);
  background: var(--el-color-warning-light-9);
  font-weight: 600;
  animation: ht-pulse 2.2s ease-in-out infinite;
}

.bar__spacer {
  flex: 1;
}

.bar__summary {
  font-size: 12px;
  color: var(--ht-text-3);
}

.fuse {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 14px;
  border: 1px solid var(--ht-warn);
  border-radius: var(--ht-radius);
  background: var(--el-color-warning-light-9);
}

.fuse__icon {
  width: 15px;
  height: 15px;
  color: var(--ht-warn);
  flex-shrink: 0;
}

.fuse__text {
  font-size: 12.5px;
  color: var(--ht-warn);
  font-weight: 600;
}

.fuse__spacer {
  flex: 1;
}

@media (prefers-reduced-motion: reduce) {
  .bar__status.is-backoff .bar__dot,
  .bar__status.is-init .bar__dot,
  .bar__review.is-active {
    animation: none;
  }
}
</style>
