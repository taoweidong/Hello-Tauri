import { mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 「知识库」卡契约测试（capability: knowledge-base）。
 *
 * platform/bridge 双侧 mock：tauri 模式下 fsRead/fsWrite 走内存文件表，
 * 钉住清单真源（knowledge/index.json）与 CRUD/登记/下架语义；web 模式钉降级。
 */
const state: { platform: 'tauri' | 'web'; files: Map<string, string> } = {
  platform: 'tauri',
  files: new Map(),
}

vi.mock('@/api', () => ({
  get platform() {
    return state.platform
  },
  bridge: {
    async fsRead(relative: string) {
      return state.files.get(relative) ?? null
    },
    async fsWrite(relative: string, content: string) {
      state.files.set(relative, content)
      return relative
    },
  },
}))

vi.mock('element-plus', () => ({
  ElMessage: { success: vi.fn(), warning: vi.fn(), error: vi.fn() },
  ElMessageBox: { confirm: vi.fn(async () => Promise.resolve()) },
}))

import { ElMessage } from 'element-plus'
import KnowledgeCard from './KnowledgeCard.vue'

const EP_STUBS: Record<string, unknown> = {
  'el-tag': true,
  'el-button': true,
  'el-input': true,
  'el-form': true,
  'el-form-item': true,
  // el-alert 桩渲染 title prop（空桩会吞掉降级提示文案，断言会失真）
  'el-alert': { template: '<div class="alert-stub">{{ title }}<slot /></div>', props: ['title'] },
}

function mountCard() {
  return mount(KnowledgeCard, { global: { stubs: EP_STUBS as never } })
}

const vmOf = (wrapper: ReturnType<typeof mountCard>) => wrapper.vm as unknown as Record<string, any>

async function seedIndex(docs: unknown) {
  state.files.set('knowledge/index.json', JSON.stringify({ docs }))
}

describe('welink/KnowledgeCard（知识库管理）', () => {
  beforeEach(() => {
    state.platform = 'tauri'
    state.files = new Map()
    vi.clearAllMocks()
  })

  it('新建：写入 md 文件 + 清单登记（标题生成文件名，.md 自动补）', async () => {
    const wrapper = mountCard()
    const vm = vmOf(wrapper)
    vm.openNew()
    vm.editing = { file: '', title: 'VPN 常见问题', content: '# VPN\n连不上先重启', isNew: true }
    await vm.saveEdit()
    expect(state.files.get('knowledge/vpn-常见问题.md')).toContain('连不上先重启')
    const index = JSON.parse(state.files.get('knowledge/index.json')!)
    expect(index.docs).toHaveLength(1)
    expect(index.docs[0]).toMatchObject({ file: 'vpn-常见问题.md', title: 'VPN 常见问题' })
    expect(vm.editing).toBeNull()
  })

  it('编辑既有文档：覆盖文件并刷新清单更新时间', async () => {
    await seedIndex([{ file: 'a.md', title: '旧标题', updatedAt: '2026-10-01 08:00:00' }])
    state.files.set('knowledge/a.md', '旧内容')
    const wrapper = mountCard()
    const vm = vmOf(wrapper)
    await vm.load()
    await vm.openEdit({ file: 'a.md', title: '旧标题', updatedAt: '2026-10-01 08:00:00' })
    vm.editing.content = '新内容'
    await vm.saveEdit()
    expect(state.files.get('knowledge/a.md')).toBe('新内容')
    const index = JSON.parse(state.files.get('knowledge/index.json')!)
    expect(index.docs[0].updatedAt).not.toBe('2026-10-01 08:00:00')
  })

  it('下架 = 仅移出清单，md 文件保留；有确认文案', async () => {
    await seedIndex([{ file: 'a.md', title: 'A', updatedAt: 'x' }, { file: 'b.md', title: 'B', updatedAt: 'y' }])
    state.files.set('knowledge/a.md', '内容')
    const wrapper = mountCard()
    const vm = vmOf(wrapper)
    await vm.load()
    await vm.offShelf({ file: 'a.md', title: 'A', updatedAt: 'x' })
    const index = JSON.parse(state.files.get('knowledge/index.json')!)
    expect(index.docs.map((d: { file: string }) => d.file)).toEqual(['b.md'])
    expect(state.files.has('knowledge/a.md')).toBe(true)
    expect(ElMessage.success).toHaveBeenCalled()
  })

  it('登记：文件存在才入清单；文件丢失给可行动提示', async () => {
    state.files.set('knowledge/manual.md', '手工内容')
    const wrapper = mountCard()
    const vm = vmOf(wrapper)
    vm.openRegister()
    vm.registering = { file: 'manual.md', title: '手工文档' }
    await vm.saveRegister()
    const index = JSON.parse(state.files.get('knowledge/index.json')!)
    expect(index.docs).toHaveLength(1)

    vm.openRegister()
    vm.registering = { file: 'missing.md', title: '缺失' }
    await vm.saveRegister()
    expect(ElMessage.warning).toHaveBeenCalledWith(expect.stringContaining('未找到'))
    expect(JSON.parse(state.files.get('knowledge/index.json')!).docs).toHaveLength(1)
  })

  it('清单里的文件被移走后编辑：给「已被移走」提示而非报错', async () => {
    await seedIndex([{ file: 'gone.md', title: 'G', updatedAt: 'x' }])
    const wrapper = mountCard()
    const vm = vmOf(wrapper)
    await vm.load()
    await vm.openEdit({ file: 'gone.md', title: 'G', updatedAt: 'x' })
    expect(ElMessage.warning).toHaveBeenCalledWith(expect.stringContaining('已被移走'))
    expect(vm.editing).toBeNull()
  })

  it('web 调试模式：整卡降级提示，不触发文件读写', async () => {
    state.platform = 'web'
    const wrapper = mountCard()
    await wrapper.vm.$nextTick()
    expect(wrapper.text()).toContain('知识库管理需桌面模式')
    expect(state.files.size).toBe(0)
  })
})
