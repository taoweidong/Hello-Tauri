import { defineStore } from 'pinia'
import { computed, nextTick, ref, watch } from 'vue'

import { bridge } from '@/api'
import type { TableRow, TableRowDraft } from '@/types'
import { logger } from '@/utils/logger'

export const CATEGORIES = ['基础设施', '数据服务', '业务应用', '安全合规']

const SEED_ROWS: TableRow[] = [
  { id: 1, name: '日志采集网关', category: '基础设施', status: 'active', amount: 12800, owner: '张伟', createdAt: '2026-01-08' },
  { id: 2, name: '订单查询服务', category: '业务应用', status: 'active', amount: 35600, owner: '李娜', createdAt: '2026-01-22' },
  { id: 3, name: '离线报表任务', category: '数据服务', status: 'inactive', amount: 7400, owner: '王强', createdAt: '2026-02-03' },
  { id: 4, name: '统一认证中心', category: '安全合规', status: 'active', amount: 52100, owner: '赵敏', createdAt: '2026-02-17' },
  { id: 5, name: '配置中心', category: '基础设施', status: 'active', amount: 9600, owner: '陈杰', createdAt: '2026-03-05' },
  { id: 6, name: '数据同步管道', category: '数据服务', status: 'active', amount: 28300, owner: '刘洋', createdAt: '2026-03-19' },
  { id: 7, name: '审计日志归档', category: '安全合规', status: 'inactive', amount: 4300, owner: '孙倩', createdAt: '2026-04-02' },
  { id: 8, name: '移动端接口层', category: '业务应用', status: 'active', amount: 41200, owner: '周琳', createdAt: '2026-04-21' },
  { id: 9, name: '指标计算引擎', category: '数据服务', status: 'active', amount: 33800, owner: '吴昊', createdAt: '2026-05-09' },
  { id: 10, name: '容器镜像仓库', category: '基础设施', status: 'inactive', amount: 15900, owner: '郑凯', createdAt: '2026-05-26' },
  { id: 11, name: '风控规则服务', category: '安全合规', status: 'active', amount: 46700, owner: '冯雪', createdAt: '2026-06-11' },
  { id: 12, name: '消息推送平台', category: '业务应用', status: 'active', amount: 21400, owner: '许阳', createdAt: '2026-06-30' },
]

/** 用本地时区拼日期：toISOString() 是 UTC，东八区凌晨会记成前一天 */
function today() {
  const now = new Date()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${now.getFullYear()}-${month}-${day}`
}

function cloneSeed(): TableRow[] {
  return SEED_ROWS.map((row) => ({ ...row }))
}

export const useTableStore = defineStore('table', () => {
  const rows = ref<TableRow[]>(cloneSeed())
  const keyword = ref('')
  const category = ref('')
  const page = ref(1)

  // 注意：每页条数是「配置」而非表格状态，唯一真值在 appStore.settings.pageSize。
  // 这里不再持有副本 —— 曾有 pageSize 副本，靠 onMounted 一次性同步，
  // 组件被 keep-alive 缓存后 onMounted 不再重跑，导致配置改动永不生效。
  const pageSize = ref(10)

  const loaded = ref(false)
  // 自增 ID 计数器：从初始数据的最大 ID 起步，避免 nextId 撞上已用 ID。
  // 曾初始化为 0，种子数据 ID 是 1–12，首次 create() 会生成 ID=1 与种子冲突。
  const nextIdSeed = ref(rows.value.reduce((max, row) => Math.max(max, row.id), 0))
  // load() 自身给 rows 赋值会触发下面的深度 watch；用该标志吞掉这一次回写，
  // 否则会把刚读到的数据又原样写回宿主（多余 I/O）。
  let restoring = false

  const filtered = computed(() => {
    const kw = keyword.value.trim().toLowerCase()
    return rows.value.filter((row) => {
      const matchKeyword = !kw || row.name.toLowerCase().includes(kw) || row.owner.toLowerCase().includes(kw)
      const matchCategory = !category.value || row.category === category.value
      return matchKeyword && matchCategory
    })
  })

  const total = computed(() => filtered.value.length)
  const pageCount = computed(() => Math.max(1, Math.ceil(total.value / Math.max(1, pageSize.value))))
  const paged = computed(() => {
    const start = (page.value - 1) * pageSize.value
    return filtered.value.slice(start, start + pageSize.value)
  })

  const stats = computed(() => {
    const all = rows.value
    const active = all.filter((row) => row.status === 'active').length
    return {
      total: all.length,
      active,
      inactive: all.length - active,
      amount: all.reduce((sum, row) => sum + row.amount, 0),
    }
  })

  const recent = computed(() => [...rows.value].sort((a, b) => b.id - a.id).slice(0, 5))

  function nextId() {
    return ++nextIdSeed.value
  }

  function syncSeedFrom(rows: TableRow[]) {
    nextIdSeed.value = rows.reduce((max, row) => Math.max(max, row.id), 0)
  }

  /** 从宿主读取已落盘的表格数据；文件不存在时沿用示例数据 */
  async function load() {
    restoring = true
    try {
      const raw = await bridge.readTable()
      if (raw) {
        const parsed = JSON.parse(raw) as TableRow[]
        if (Array.isArray(parsed) && parsed.length) {
          rows.value = parsed
          syncSeedFrom(parsed)
          logger.info(`已加载表格数据 ${parsed.length} 条`)
        }
      }
    } catch (error) {
      logger.error('加载表格数据失败，沿用示例数据', error)
    }
    loaded.value = true
    // rows 的赋值会在当前 tick 之后触发深度 watch；等它触发完（被 restoring 吞掉）
    // 再解除标志，之后的真实变更才会回写。
    await nextTick()
    restoring = false
  }

  async function persist(reason: string) {
    if (!loaded.value || restoring) return
    try {
      await bridge.writeTable(JSON.stringify(rows.value, null, 2))
      logger.info(`表格数据已保存（${reason}），共 ${rows.value.length} 条`)
    } catch (error) {
      logger.error('保存表格数据失败', error)
    }
  }

  function create(draft: TableRowDraft) {
    rows.value.unshift({ ...draft, id: nextId(), createdAt: today() })
    page.value = 1
  }

  function update(id: number, draft: TableRowDraft) {
    const target = rows.value.find((row) => row.id === id)
    if (target) {
      Object.assign(target, draft)
    }
  }

  function remove(ids: number[]) {
    if (!ids.length) return
    rows.value = rows.value.filter((row) => !ids.includes(row.id))
    page.value = Math.min(page.value, pageCount.value)
  }

  function resetSeed() {
    rows.value = cloneSeed()
    syncSeedFrom(rows.value)
    keyword.value = ''
    category.value = ''
    page.value = 1
  }

  watch([keyword, category], () => {
    page.value = 1
  })

  // 任何影响落盘数据的变更都触发持久化。同样加 loaded 守卫，
  // 避免初始加载阶段把空数据回写覆盖磁盘内容。
  watch(
    rows,
    () => {
      void persist('数据变更')
    },
    { deep: true },
  )

  return {
    rows,
    keyword,
    category,
    page,
    pageSize,
    loaded,
    filtered,
    total,
    pageCount,
    paged,
    stats,
    recent,
    load,
    create,
    update,
    remove,
    resetSeed,
  }
})