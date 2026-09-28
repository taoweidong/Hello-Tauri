<script setup lang="ts">
/**
 * 首次引导向导（设计 §11.0 · O8）—— enabled=off 且未配置过时的三步卡片。
 *
 * 存在的理由：这个助手的**失败模式是静默的**。没填工号 → 自发消息过滤失效 →
 * SafetyGate 熔断兜底 → 用户看到的是「开关打开了但一条都不回」。
 * 与其让人去翻日志，不如在首次进入时就把三件事办掉：
 *   ① 确认数据来源（mock 可直接用；cli 需填 exe 路径）
 *   ② 填工号（防自回复循环的关键）
 *   ③ 勾选一个演示群并开启 → 立刻能看到完整链路跑起来
 *
 * 全部完成才允许「开启助手」；未完成时按钮禁用并说明缺什么。
 */
import { computed, onMounted, reactive, ref } from 'vue'
import { ElMessage } from 'element-plus'

import { IconArrowRight, IconCheck, IconRefresh } from '@/components/icons'
import { useAppStore } from '@/stores/app'
import { useWelinkStore } from '@/stores/welink'

const emit = defineEmits<{ (e: 'done'): void; (e: 'go-settings'): void }>()

const store = useWelinkStore()
const appStore = useAppStore()

const step = ref(1)
const busy = ref(false)
const candidates = ref<Array<{ convId: string; title: string; convType: string }>>([])
const form = reactive({ myUserId: '', source: 'mock' as 'mock' | 'cli', cliPath: '', pickedConvId: '' })

const canNext = computed(() => {
  if (step.value === 1) return form.source === 'mock' || form.cliPath.trim() !== ''
  if (step.value === 2) return form.myUserId.trim() !== ''
  return Boolean(form.pickedConvId)
})

const stepHint = computed(() => {
  if (step.value === 1)
    return form.source === 'mock' ? '当前使用模拟数据，可直接下一步' : '请填写 welink-cli.exe 的完整路径'
  if (step.value === 2) return '工号用于识别「我自己发的」消息，留空会导致自回复循环（会被熔断拦下但无法回复）'
  return '选一个演示群，完成后助手会自动拉取该群消息并尝试回复'
})

/** 同步候选会话（mock 端口内置一批演示群） */
async function loadCandidates() {
  busy.value = true
  try {
    await store.init(appStore.settings.weLink)
    const result = await store.syncConversations()
    candidates.value = (await store.fetchConversations(50)).map((conv) => ({
      convId: conv.convId,
      title: conv.title,
      convType: conv.convType,
    }))
    if (!candidates.value.length) ElMessage.warning('未从数据源拉到任何会话，请检查来源配置')
    else ElMessage.success(`已导入 ${result.imported} 个候选会话`)
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '同步会话失败')
  } finally {
    busy.value = false
  }
}

/** 完成引导：写配置 → 开启监控与回复 → 启动助手 */
async function finish() {
  busy.value = true
  try {
    const next = {
      ...store.settings,
      enabled: true,
      welinkSource: form.source,
      cliPath: form.cliPath.trim() || store.settings.cliPath,
      myUserId: form.myUserId.trim(),
    }
    store.applySettings(next)
    appStore.settings.weLink = { ...appStore.settings.weLink, ...next }

    if (form.pickedConvId) {
      // 演示群：既监控也自动回复，让用户立刻看到链路跑通
      await store.updateConversation(form.pickedConvId, { watching: true, autoReply: true })
    }

    const report = await store.start()
    if (report) {
      ElMessage.success('助手已启动，正在拉取消息…')
      emit('done')
    } else {
      ElMessage.error('启动异常，请到配置页检查来源与路径')
    }
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '启动失败')
  } finally {
    busy.value = false
  }
}

onMounted(() => {
  form.source = store.settings.welinkSource
  form.cliPath = store.settings.cliPath
  form.myUserId = store.settings.myUserId
})
</script>

<template>
  <section class="wiz ht-card">
    <header class="wiz__head">
      <span class="wiz__title">首次使用引导</span>
      <span class="wiz__sub">三步配置好，立刻看到「拉取 → 生成 → 闸口 → 外发」的完整链路</span>
      <span class="spacer" />
      <span class="wiz__steps">
        <span
          v-for="index in 3"
          :key="index"
          class="wiz__step"
          :class="{ 'is-active': step === index, 'is-done': step > index }"
        >
          {{ index }}
        </span>
      </span>
    </header>

    <div class="wiz__body">
      <!-- ① 数据来源 -->
      <div v-if="step === 1" class="wiz__form">
        <el-radio-group v-model="form.source">
          <el-radio-button value="mock">模拟数据（推荐先体验）</el-radio-button>
          <el-radio-button value="cli">真实 welink-cli</el-radio-button>
        </el-radio-group>
        <div v-if="form.source === 'cli'" class="wiz__field">
          <span class="wiz__label">cli 路径</span>
          <el-input v-model="form.cliPath" placeholder="welink-cli.exe 或完整路径，如 D:\tools\welink-cli.exe" />
        </div>
        <p v-else class="wiz__note">模拟数据内置演示群与剧本，无需任何外部程序即可跑通全流程。</p>
      </div>

      <!-- ② 工号 -->
      <div v-else-if="step === 2" class="wiz__form">
        <div class="wiz__field">
          <span class="wiz__label">我的工号</span>
          <el-input v-model="form.myUserId" placeholder="如 10086，需与 WeLink 中的工号一致" />
        </div>
        <p class="wiz__note">用于过滤你自己发出的消息 —— 不填会导致「自己回自己」，助手无法正常工作。</p>
      </div>

      <!-- ③ 演示群 -->
      <div v-else class="wiz__form">
        <div class="wiz__actions">
          <el-button size="small" :icon="IconRefresh" :loading="busy" @click="loadCandidates">同步候选会话</el-button>
          <span v-if="candidates.length" class="wiz__count">共 {{ candidates.length }} 个候选</span>
        </div>
        <div class="wiz__list">
          <button
            v-for="conv in candidates"
            :key="conv.convId"
            class="wiz__item pressable"
            :class="{ 'is-picked': form.pickedConvId === conv.convId }"
            @click="form.pickedConvId = conv.convId"
          >
            <span class="wiz__item-title">{{ conv.title || conv.convId }}</span>
            <span class="wiz__item-id mono">{{ conv.convId }}</span>
            <IconCheck v-if="form.pickedConvId === conv.convId" class="wiz__item-check" />
          </button>
          <p v-if="!candidates.length" class="wiz__note">点上方「同步候选会话」从数据源导入可监控的群/联系人。</p>
        </div>
      </div>
    </div>

    <footer class="wiz__foot">
      <span class="wiz__hint">{{ stepHint }}</span>
      <span class="spacer" />
      <el-button v-if="step > 1" size="small" text @click="step -= 1">上一步</el-button>
      <el-button v-if="step < 3" size="small" type="primary" :disabled="!canNext" @click="step += 1">下一步</el-button>
      <el-button v-else size="small" type="primary" :loading="busy" :disabled="!canNext" @click="finish">
        开启助手 <IconArrowRight class="wiz__btn-icon" />
      </el-button>
      <el-button size="small" text @click="emit('go-settings')">跳过，去手动配置</el-button>
    </footer>
  </section>
</template>

<style scoped>
.wiz {
  display: flex;
  flex-direction: column;
}

.wiz__head {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 14px;
  border-bottom: 1px solid var(--ht-line);
}

.wiz__title {
  font-size: 13px;
  font-weight: 600;
  color: var(--ht-text-1);
}

.wiz__sub {
  font-size: 11.5px;
  color: var(--ht-text-3);
}

.spacer {
  flex: 1;
}

.wiz__steps {
  display: flex;
  gap: 6px;
}

.wiz__step {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  border-radius: 50%;
  border: 1px solid var(--ht-line-strong);
  color: var(--ht-text-3);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}

.wiz__step.is-active {
  border-color: var(--ht-primary);
  background: var(--ht-primary);
  color: #fff;
}

.wiz__step.is-done {
  border-color: var(--ht-ok);
  color: var(--ht-ok);
}

.wiz__body {
  padding: 14px;
  min-height: 120px;
}

.wiz__form {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.wiz__field {
  display: flex;
  align-items: center;
  gap: 10px;
}

.wiz__label {
  font-size: 12.5px;
  color: var(--ht-text-2);
  white-space: nowrap;
}

.wiz__field :deep(.el-input) {
  max-width: 380px;
}

.wiz__note {
  margin: 0;
  font-size: 11.5px;
  color: var(--ht-text-3);
  line-height: 1.7;
}

.wiz__actions {
  display: flex;
  align-items: center;
  gap: 10px;
}

.wiz__count {
  font-size: 11.5px;
  color: var(--ht-text-3);
}

.wiz__list {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  gap: 8px;
  max-height: 200px;
  overflow-y: auto;
}

.wiz__item {
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 8px 10px;
  border: 1px solid var(--ht-line);
  border-radius: var(--ht-radius-sm);
  background: var(--ht-surface);
  color: var(--ht-text-1);
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.wiz__item:hover {
  border-color: var(--ht-primary-line);
}

.wiz__item.is-picked {
  border-color: var(--ht-primary);
  background: var(--ht-primary-soft);
}

.wiz__item-title {
  font-size: 12.5px;
  font-weight: 500;
}

.wiz__item-id {
  font-size: 11px;
  color: var(--ht-text-3);
}

.wiz__item-check {
  width: 13px;
  height: 13px;
  color: var(--ht-primary);
  align-self: flex-end;
}

.wiz__foot {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 14px;
  border-top: 1px solid var(--ht-line);
  flex-wrap: wrap;
}

.wiz__hint {
  font-size: 11.5px;
  color: var(--ht-text-3);
  max-width: 60%;
  line-height: 1.6;
}

.wiz__btn-icon {
  width: 13px;
  height: 13px;
  margin-left: 4px;
}
</style>
