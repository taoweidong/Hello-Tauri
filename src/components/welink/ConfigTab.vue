<script setup lang="ts">
/**
 * Tab「监控配置」（设计 §11.5，R1）—— `welink_conversations` 全量表 + 增删改。
 *
 * 这一页承载的核心设计决策是**「监控」与「自动回复」正交**（§5A.1 的 L3 分级）：
 *  * `watching` = 是否拉取存档（白名单勾选制）
 *  * `autoReply` = 是否允许自动外发（默认关，且仅 watching 时可开）
 *
 * 两者分开的理由：**存档是无风险的信息留存，外发是有风险的对外动作**。
 * 混成一个开关会出现「只想存档却把群回复打开了」这种不可逆的误操作。
 *
 * 删除会话会级联删掉该会话的全部消息与任务，因此必须二次确认并如实告知条数。
 */
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'

import { IconCheck, IconFilter, IconPlus, IconRefresh } from '@/components/icons'
import { useAppStore } from '@/stores/app'
import { useWelinkStore } from '@/stores/welink'
import type { WelinkConversation, WelinkConvType } from '@/types/welink'
import { asBoolean, rowOf } from '@/utils/table'
import { isMuted as isConversationMuted, muteLabel as muteLabelOf } from '@/utils/welink-display'

const store = useWelinkStore()
const appStore = useAppStore()

/**
 * `<el-table>` 插槽行的业务类型收窄（根因见 `utils/table.ts`）。
 * 上游 `el-table-column` 的插槽签名硬编码为 `DefaultRow`，不做泛型推断，
 * 因此每列插槽的 `row` 都必须显式收窄后才能交给强类型函数。
 */
const convOf = (row: unknown): WelinkConversation => rowOf<WelinkConversation>(row)

const filter = reactive({ keyword: '', type: [] as WelinkConvType[], onlyWatching: false })
const page = ref(1)
const loading = ref(false)
const selected = ref<WelinkConversation[]>([])

const pageSize = computed(() => appStore.settings.pageSize || 10)

/** 全量会话（口径唯一：总数由仓储 countConversations 提供，不在前端二次聚合） */
const rows = ref<WelinkConversation[]>([])

const filtered = computed(() => {
  const kw = filter.keyword.trim().toLowerCase()
  return rows.value.filter((conv) => {
    if (filter.type.length && !filter.type.includes(conv.convType)) return false
    if (filter.onlyWatching && !conv.watching) return false
    if (kw && !conv.title.toLowerCase().includes(kw) && !conv.convId.toLowerCase().includes(kw)) return false
    return true
  })
})

/** 客户端筛选 + 分页：会话量级小（几十~几百），不下推 SQL 以简化仓储 */
const pagedRows = computed(() => filtered.value.slice((page.value - 1) * pageSize.value, page.value * pageSize.value))

/**
 * 分页脚总数必须与筛选实时联动（曾用 ref 只在 load() 赋值：筛选后仍显示全量条数，
 * 翻页还会落到空表——数据「看起来丢了」）。computed 保证口径唯一。
 */
const total = computed(() => filtered.value.length)

// 筛选变化时回到第一页：否则「第 3 页 + 筛选只剩 5 条」直接显示空表
watch(filter, () => {
  page.value = 1
})

async function load() {
  loading.value = true
  try {
    // 拉全量（上限 500），筛选在内存做 —— 分页脚用筛选后的长度
    rows.value = await store.fetchConversations(500)
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '加载会话配置失败')
  } finally {
    loading.value = false
  }
}

/**
 * 同步会话（§11.5）：先拉 diff 预览，用户确认后再落库。
 *
 * 两步式的意义：候选清单来自外部数据源，数量可能几十上百，直接导入等于一次
 * 不可见的批量写。先给一张「新增 N / 已有 M」的清单，并允许对新会话**直接勾选监控**，
 * 用户点「确认导入」才算数 —— 且 autoReply 一律保持关（默认不回复是底线）。
 */
const syncDialog = reactive({
  open: false,
  loading: false,
  known: 0,
  total: 0,
  fresh: [] as Array<{ convType: WelinkConvType; convId: string; title: string }>,
  watchIds: [] as string[],
})

async function syncConversations() {
  syncDialog.loading = true
  try {
    const preview = await store.previewSync()
    syncDialog.known = preview.known
    syncDialog.total = preview.total
    syncDialog.fresh = preview.fresh
    syncDialog.watchIds = []
    syncDialog.open = true
    if (!preview.fresh.length) ElMessage.info('没有新会话需要导入')
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '同步会话失败')
  } finally {
    syncDialog.loading = false
  }
}

async function confirmSync() {
  syncDialog.loading = true
  try {
    const result = await store.syncConversations(syncDialog.watchIds)
    syncDialog.open = false
    ElMessage.success(
      `同步完成：新增 ${result.imported} 个会话（默认不回复）` +
        (result.watched ? `，${result.watched} 个已开启监控` : ''),
    )
    await load()
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '同步会话失败')
  } finally {
    syncDialog.loading = false
  }
}

// —— 新增 / 编辑 ——
const dialog = reactive({
  open: false,
  editing: false,
  convType: 'group' as WelinkConvType,
  convId: '',
  title: '',
  remark: '',
})

function openCreate() {
  dialog.open = true
  dialog.editing = false
  dialog.convType = 'group'
  dialog.convId = ''
  dialog.title = ''
  dialog.remark = ''
}

function openEdit(conv: WelinkConversation) {
  dialog.open = true
  dialog.editing = true
  dialog.convType = conv.convType
  dialog.convId = conv.convId
  dialog.title = conv.title
  dialog.remark = conv.remark
}

async function submitDialog() {
  const convId = dialog.convId.trim()
  if (!convId) {
    ElMessage.warning('会话 ID 不能为空')
    return
  }
  try {
    await store.upsertConversation({
      convType: dialog.convType,
      convId,
      title: dialog.title.trim(),
      remark: dialog.remark.trim(),
    })
    dialog.open = false
    ElMessage.success('已保存')
    await load()
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '保存失败')
  }
}

// —— 开关 ——

/**
 * 监控开关。关掉监控时 store 会联动关掉自动回复（watching=0 的会话不该继续外发），
 * 这里给出提示让用户知道这个联动是刻意的。
 */
async function toggleWatching(conv: WelinkConversation, value: boolean) {
  await store.updateConversation(conv.convId, { watching: value })
  if (!value && conv.autoReply) ElMessage.info(`「${conv.title || conv.convId}」已停止监控，自动回复同步关闭`)
  await load()
}

/** 自动回复开关（L3）：仅 watching 时可开 —— UI 与 Gate 双重约束 */
async function toggleAutoReply(conv: WelinkConversation, value: boolean) {
  if (value && !conv.watching) {
    ElMessage.warning('请先开启「监控」，未监控的会话不参与拉取也无法回复')
    return
  }
  await store.updateConversation(conv.convId, { autoReply: value })
  await load()
}

/** O11 静音 */
async function mute(conv: WelinkConversation, hours: number) {
  await store.muteConversation(conv.convId, hours)
  ElMessage.success(`「${conv.title || conv.convId}」已静音 ${hours} 小时`)
  await load()
}

async function remove(conv: WelinkConversation) {
  const messageCount = await store.countMessagesOf(conv.convId)
  const detail = messageCount
    ? `该会话有 ${messageCount} 条存档消息，删除将**级联删除**这些消息与全部回复任务，不可恢复。`
    : '该会话暂无存档消息，删除后仅移除配置。'
  const confirmed = await ElMessageBox.confirm(detail, `删除会话「${conv.title || conv.convId}」`, {
    type: 'warning',
    confirmButtonText: '确认删除',
    cancelButtonText: '取消',
    dangerouslyUseHTMLString: false,
  }).catch(() => false)
  if (confirmed === false) return
  await store.removeConversation(conv.convId)
  ElMessage.success('已删除')
  await load()
}

// —— 批量 ——

async function batchAutoReply(enabled: boolean) {
  if (!selected.value.length) return
  const affected = selected.value.length
  const remainder = Math.max(0, store.settings.safety.globalHourlyCap - store.safety.globalCount)
  const confirmed = await ElMessageBox.confirm(
    `将把 ${affected} 个会话的自动回复设为「${enabled ? '开' : '关'}」。\n` +
      (enabled
        ? `注意：开启后这些会话的消息会被自动回复，本小时全局配额还剩 ${remainder} 条。`
        : '关闭后这些会话只存档、不外发，未完成任务会停留在待审。'),
    enabled ? '批量开启自动回复' : '批量关闭自动回复',
    { type: enabled ? 'warning' : 'info', confirmButtonText: '确认', cancelButtonText: '取消' },
  ).catch(() => false)
  if (confirmed === false) return
  // 只对监控中的会话生效：未监控的会话开启 autoReply 无意义（Gate 会拦）
  const targets = selected.value.filter((conv) => enabled === false || conv.watching).map((conv) => conv.convId)
  const changed = await store.setAutoReply(targets, enabled)
  ElMessage.success(`已更新 ${changed} 个会话`)
  selected.value = []
  await load()
}

function handleSelectionChange(selection: WelinkConversation[]) {
  selected.value = selection
}

const TYPE_LABEL: Record<WelinkConvType, string> = { group: '群聊', private: '私聊' }

/**
 * 静音剩余文案（O11）—— 统一实现见 `utils/welink-display`。
 * 抽取前这里与 `MessagesTab` 各有一份，格式与到期判定都不一致（T-4）。
 * 保留这两个薄包装只是为了模板里少写 `conv.muteUntil`。
 */
const muteLabel = (conv: WelinkConversation): string => muteLabelOf(conv.muteUntil)
const isMuted = (conv: WelinkConversation): boolean => isConversationMuted(conv.muteUntil)

onMounted(load)
</script>

<template>
  <div class="conf">
    <!-- 未启用黄条（§11.5 引导） -->
    <el-alert
      v-if="!store.settings.enabled"
      class="conf__alert"
      type="warning"
      :closable="false"
      show-icon
      title="助手尚未启用"
      description="监控配置可以随时编辑，但拉取与自动回复需要先在「配置」页打开总开关。"
    />

    <!-- 顶部工具条 -->
    <div class="conf__bar">
      <div class="conf__search">
        <IconFilter class="conf__search-icon" />
        <input v-model="filter.keyword" class="conf__input" placeholder="按名称 / 会话 ID 过滤" />
      </div>
      <el-select v-model="filter.type" multiple collapse-tags placeholder="类型" size="small" class="conf__sel">
        <el-option label="群聊" value="group" />
        <el-option label="私聊" value="private" />
      </el-select>
      <el-checkbox v-model="filter.onlyWatching" size="small">仅看监控中</el-checkbox>
      <el-button size="small" :icon="IconRefresh" @click="load()">刷新</el-button>
      <span class="spacer" />
      <el-button size="small" type="primary" plain @click="syncConversations">同步会话</el-button>
      <el-button size="small" :icon="IconPlus" @click="openCreate">新增监控</el-button>
    </div>

    <!-- 批量操作条 -->
    <div v-if="selected.length" class="conf__batch">
      <span class="conf__batch-text">已选 {{ selected.length }} 项</span>
      <el-button size="small" type="primary" plain @click="batchAutoReply(true)">批量开自动回复</el-button>
      <el-button size="small" plain @click="batchAutoReply(false)">批量关自动回复</el-button>
      <el-button size="small" text @click="selected = []">取消选择</el-button>
    </div>

    <el-table
      v-loading="loading"
      :data="pagedRows"
      size="small"
      class="conf__table"
      empty-text="尚无会话配置，点「同步会话」从数据源导入"
      @selection-change="handleSelectionChange"
    >
      <el-table-column type="selection" width="42" />
      <el-table-column label="类型" width="70">
        <template #default="{ row }">
          <el-tag size="small" effect="plain">{{ TYPE_LABEL[row.convType as WelinkConvType] }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="会话 ID" width="170">
        <template #default="{ row }">
          <span class="mono">{{ row.convId }}</span>
        </template>
      </el-table-column>
      <el-table-column label="名称" min-width="150">
        <template #default="{ row }">
          <div>{{ row.title || '（未命名）' }}</div>
          <div v-if="isMuted(convOf(row))" class="cell-muted">{{ muteLabel(convOf(row)) }}</div>
        </template>
      </el-table-column>
      <el-table-column label="备注" min-width="130">
        <template #default="{ row }">
          <span v-if="row.remark" class="cell-dim">{{ row.remark }}</span>
          <span v-else class="cell-dim">—</span>
        </template>
      </el-table-column>
      <el-table-column label="监控" width="100" align="center">
        <template #default="{ row }">
          <el-switch
            :model-value="row.watching"
            size="small"
            @update:model-value="(value: string | number | boolean) => toggleWatching(convOf(row), asBoolean(value))"
          />
        </template>
      </el-table-column>
      <el-table-column label="自动回复" width="170">
        <template #default="{ row }">
          <el-switch
            :model-value="row.autoReply"
            size="small"
            :disabled="!row.watching"
            @update:model-value="(value: string | number | boolean) => toggleAutoReply(convOf(row), asBoolean(value))"
          />
          <div v-if="row.autoReply" class="cell-dim num">
            本小时 {{ store.safety.convCounts[row.convId] ?? 0 }}/{{ store.settings.safety.perConvHourlyCap }}
          </div>
          <div v-else-if="!row.watching" class="cell-dim">需先监控</div>
        </template>
      </el-table-column>
      <!-- 游标只读（§11.5：调试用，不参与编辑） -->
      <el-table-column label="游标" width="120">
        <template #default="{ row }">
          <span class="cell-dim mono" :title="row.lastCursor || '（尚未拉取）'">{{ row.lastCursor || '—' }}</span>
        </template>
      </el-table-column>
      <el-table-column label="操作" width="200" fixed="right">
        <template #default="{ row }">
          <el-button size="small" text type="primary" @click="openEdit(convOf(row))">编辑</el-button>
          <el-dropdown trigger="click" @command="(hours: number) => mute(convOf(row), hours)">
            <el-button size="small" text>静音</el-button>
            <template #dropdown>
              <el-dropdown-menu>
                <el-dropdown-item :command="1">静音 1 小时</el-dropdown-item>
                <el-dropdown-item :command="8">静音 8 小时</el-dropdown-item>
                <el-dropdown-item :command="24">静音到今天结束</el-dropdown-item>
              </el-dropdown-menu>
            </template>
          </el-dropdown>
          <el-button size="small" text type="danger" @click="remove(convOf(row))">删除</el-button>
        </template>
      </el-table-column>
    </el-table>

    <div class="conf__pager">
      <el-pagination
        v-model:current-page="page"
        :page-size="pageSize"
        :total="total"
        layout="total, prev, pager, next"
        size="small"
        background
      />
    </div>

    <p class="conf__note">
      「监控」= 拉取存档（无风险）；「自动回复」= 允许自动外发（有风险，默认关）。两者刻意分开，避免只想存档却误开外发。
    </p>

    <!-- 新增 / 编辑弹层 -->
    <el-dialog v-model="dialog.open" :title="dialog.editing ? '编辑会话' : '新增监控会话'" width="460px">
      <el-form label-width="80px" @submit.prevent>
        <el-form-item label="类型">
          <el-radio-group v-model="dialog.convType" :disabled="dialog.editing">
            <el-radio-button value="group">群聊</el-radio-button>
            <el-radio-button value="private">私聊</el-radio-button>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="会话 ID">
          <el-input v-model="dialog.convId" :disabled="dialog.editing" placeholder="群号 / 工号，需与数据源一致" />
        </el-form-item>
        <el-form-item label="名称">
          <el-input v-model="dialog.title" maxlength="60" placeholder="展示用名称" />
        </el-form-item>
        <el-form-item label="备注">
          <el-input v-model="dialog.remark" maxlength="80" placeholder="如「核心业务群」" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialog.open = false">取消</el-button>
        <el-button type="primary" :icon="IconCheck" @click="submitDialog">保存</el-button>
      </template>
    </el-dialog>

    <!-- 同步会话 diff 预览（§11.5）：新增项可勾选直接开启监控；已有项从不覆盖 -->
    <el-dialog v-model="syncDialog.open" title="同步会话" width="620px">
      <p class="sync__summary">
        数据源候选共 <b class="num">{{ syncDialog.total }}</b> 个：新增
        <b class="num sync__fresh">{{ syncDialog.fresh.length }}</b> 个、已有
        <b class="num">{{ syncDialog.known }}</b> 个（已有项不覆盖监控 / 回复 / 备注设置）。
      </p>

      <div class="sync__hint-row">
        <span class="sync__hint">导入的新会话默认**不监控、不回复**；勾选下面「立即监控」的会直接开启拉取。</span>
        <span class="spacer" />
        <el-checkbox
          :model-value="syncDialog.watchIds.length === syncDialog.fresh.length && syncDialog.fresh.length > 0"
          :indeterminate="syncDialog.watchIds.length > 0 && syncDialog.watchIds.length < syncDialog.fresh.length"
          :disabled="!syncDialog.fresh.length"
          size="small"
          @update:model-value="
            (value: string | number | boolean) =>
              (syncDialog.watchIds = asBoolean(value) ? syncDialog.fresh.map((item) => item.convId) : [])
          "
        >
          全选
        </el-checkbox>
      </div>

      <div v-if="syncDialog.fresh.length" class="sync__list">
        <el-checkbox-group v-model="syncDialog.watchIds">
          <label v-for="item in syncDialog.fresh" :key="item.convId" class="sync__row">
            <el-checkbox :value="item.convId" size="small">
              <span class="sync__row-id mono">{{ item.convId }}</span>
              <span class="sync__row-title">{{ item.title || '（无名称）' }}</span>
              <el-tag size="small" effect="plain">{{ TYPE_LABEL[item.convType] }}</el-tag>
            </el-checkbox>
          </label>
        </el-checkbox-group>
      </div>
      <p v-else class="sync__empty">没有新会话需要导入，数据源与本地配置已一致。</p>

      <template #footer>
        <el-button @click="syncDialog.open = false">取消</el-button>
        <el-button type="primary" :icon="IconCheck" :loading="syncDialog.loading" @click="confirmSync">
          确认导入{{ syncDialog.watchIds.length ? `（${syncDialog.watchIds.length} 个开启监控）` : '' }}
        </el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.conf {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px 14px 16px;
}

.conf__alert {
  margin: 0;
}

.conf__bar {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.conf__search {
  position: relative;
  width: 210px;
}

.conf__search-icon {
  position: absolute;
  left: 9px;
  top: 50%;
  transform: translateY(-50%);
  width: 13px;
  height: 13px;
  color: var(--ht-text-3);
  pointer-events: none;
}

.conf__input {
  width: 100%;
  height: 28px;
  padding: 0 9px 0 27px;
  border: 1px solid var(--ht-line);
  border-radius: var(--ht-radius-sm);
  background: var(--ht-surface);
  color: var(--ht-text-1);
  font: inherit;
  font-size: 12.5px;
}

.conf__input:focus {
  outline: none;
  border-color: var(--ht-primary);
}

.conf__sel {
  width: 130px;
}

.spacer {
  flex: 1;
}

.conf__batch {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 12px;
  border: 1px solid var(--ht-primary-line);
  border-radius: var(--ht-radius-sm);
  background: var(--ht-primary-soft);
}

.conf__batch-text {
  font-size: 12px;
  font-weight: 600;
  color: var(--ht-primary);
}

.conf__table {
  border: 1px solid var(--ht-line);
  border-radius: var(--ht-radius-sm);
}

.cell-dim {
  font-size: 11.5px;
  color: var(--ht-text-3);
}

/* ---- 同步会话 diff 预览 ---- */
.sync__summary {
  margin: 0 0 10px;
  font-size: 13px;
  color: var(--ht-text-1);
}

.sync__fresh {
  color: var(--ht-primary);
}

.sync__hint-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}

.sync__hint {
  font-size: 12px;
  color: var(--ht-text-3);
}

.sync__list {
  max-height: 320px;
  overflow: auto;
  border: 1px solid var(--ht-line);
  border-radius: var(--ht-radius-sm);
  padding: 4px 10px;
}

.sync__row {
  display: block;
  padding: 3px 0;
  cursor: pointer;
}

.sync__row-id {
  display: inline-block;
  min-width: 96px;
  font-size: 12px;
  color: var(--ht-text-2);
}

.sync__row-title {
  display: inline-block;
  min-width: 160px;
  margin-right: 6px;
  font-size: 12.5px;
  color: var(--ht-text-1);
}

.sync__empty {
  padding: 18px 0;
  text-align: center;
  font-size: 12.5px;
  color: var(--ht-text-3);
}

.cell-muted {
  margin-top: 2px;
  font-size: 11px;
  color: var(--ht-warn);
}

.conf__pager {
  display: flex;
  justify-content: flex-end;
}

.conf__note {
  margin: 0;
  font-size: 11.5px;
  color: var(--ht-text-3);
  line-height: 1.7;
}
</style>
