import { defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'

import { recordsBackend, cloneSeed, type RecordsBackend } from '@/repositories/records'
import type { TableRow, TableRowDraft } from '@/types'
import { logger } from '@/utils/logger'

export { CATEGORIES } from '@/repositories/records'

/**
 * 表格业务 store。
 *
 * 持久化模型（P3 起）：不再"全量数组 + 写 JSON 快照"，而是每个写操作即时落到
 * 后端（桌面 = SQLite records 表，浏览器 = 内存/localStorage，Q3）。
 * store 里保留全量行做本地筛选/分页 —— 数据规模在千级以内这完全够用，
 * 万级再上 SQL 分页下推（接口已隔离，改 store 不换后端契约）。
 */
export const useTableStore = defineStore('table', () => {
  const rows = ref<TableRow[]>([])
  const keyword = ref('')
  const category = ref('')
  const page = ref(1)

  // 每页条数是「配置」而非表格状态，唯一真值在 appStore.settings.pageSize，
  // 这里只读消费。
  const pageSize = ref(10)

  const loaded = ref(false)
  const busy = ref(false)

  /** 后端可注入（测试用内存假件），默认按运行环境选择 */
  const backend: RecordsBackend = recordsBackend

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

  async function load() {
    busy.value = true
    try {
      await backend.prepare()
      rows.value = await backend.loadAll()
      logger.info(`已加载表格数据 ${rows.value.length} 条`)
    } catch (error) {
      logger.error('加载表格数据失败，使用示例数据兜底', error)
      rows.value = cloneSeed()
    } finally {
      busy.value = false
    }
    loaded.value = true
  }

  async function create(draft: TableRowDraft) {
    busy.value = true
    try {
      const created = await backend.insert(draft)
      rows.value.unshift(created)
      page.value = 1
    } catch (error) {
      logger.error('新增记录失败', error)
      throw error
    } finally {
      busy.value = false
    }
  }

  async function update(id: number, draft: TableRowDraft) {
    busy.value = true
    try {
      await backend.update(id, draft)
      const target = rows.value.find((row) => row.id === id)
      if (target) Object.assign(target, draft)
    } catch (error) {
      logger.error('更新记录失败', error)
      throw error
    } finally {
      busy.value = false
    }
  }

  async function remove(ids: number[]) {
    if (!ids.length) return
    busy.value = true
    try {
      await backend.remove(ids)
      rows.value = rows.value.filter((row) => !ids.includes(row.id))
      page.value = Math.min(page.value, pageCount.value)
    } catch (error) {
      logger.error('删除记录失败', error)
      throw error
    } finally {
      busy.value = false
    }
  }

  async function resetSeed() {
    busy.value = true
    try {
      rows.value = await backend.resetSeed()
      keyword.value = ''
      category.value = ''
      page.value = 1
    } catch (error) {
      logger.error('恢复示例数据失败', error)
      throw error
    } finally {
      busy.value = false
    }
  }

  watch([keyword, category], () => {
    page.value = 1
  })

  return {
    rows,
    keyword,
    category,
    page,
    pageSize,
    loaded,
    busy,
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