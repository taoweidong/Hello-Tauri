import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 「知识库」卡契约测试（capability: knowledge-base + knowledge-sedimentation）。
 *
 * platform/bridge 双侧 mock：tauri 模式下 fsRead/fsWrite 走内存文件表，钉住清单
 * 真源（knowledge/index.json）与 CRUD/登记/下架/来源语义；web 模式钉降级。
 * 卡片经 knowledgeStore（真实实现 + Pinia）访问端口 —— 同时覆盖「卡片迁移到
 * store 装配」的接线（UI 禁触 @/infra/** 的 D4 闸门），welink store 打最小假件
 * （本卡不触运行时；评审流转的 harvester 链路另有 harvester.spec 钉住）。
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

vi.mock('@/stores/welink', () => ({
  useWelinkStore: () => ({
    conversations: [],
    loadConversations: async () => undefined,
    ensureRuntime: async () => {
      throw new Error('知识库卡不应触达运行时（评审流转另有链路）')
    },
  }),
}))

vi.mock('element-plus', () => ({
  ElMessage: { success: vi.fn(), warning: vi.fn(), error: vi.fn() },
  ElMessageBox: { confirm: vi.fn(async () => Promise.resolve()) },
}))

import { ElMessage } from 'element-plus'
import KnowledgeCard from './KnowledgeCard.vue'
import { useKnowledgeStore } from '@/stores/welink/knowledge'

const EP_STUBS: Record<string, unknown> = {
  'el-tag': { template: '<span class="tag-stub"><slot /></span>' },
  'el-button': { template: '<button class="btn-stub"><slot /></button>' },
  'el-input': true,
  'el-select': true,
  'el-option': true,
  'el-radio-group': true,
  'el-radio-button': true,
  'el-form': true,
  'el-form-item': true,
  // el-alert 桩渲染 title prop（空桩会吞掉降级提示文案，断言会失真）
  'el-alert': { template: '<div class="alert-stub">{{ title }}<slot /></div>', props: ['title'] },
}

function mountCard() {
  return mount(KnowledgeCard, { global: { plugins: [createPinia()], stubs: EP_STUBS as never } })
}

const vmOf = (wrapper: ReturnType<typeof mountCard>) => wrapper.vm as unknown as Record<string, any>

async function seedIndex(docs: unknown) {
  state.files.set('knowledge/index.json', JSON.stringify({ docs }))
}

describe('welink/KnowledgeCard（知识库管理）', () => {
  beforeEach(() => {
    state.platform = 'tauri'
    state.files = new Map()
    setActivePinia(createPinia())
    vi.clearAllMocks()
  })

  it('新建：写入 md 文件 + 清单登记（标题生成文件名，.md 自动补，来源 manual）', async () => {
    const wrapper = mountCard()
    const vm = vmOf(wrapper)
    vm.openNew()
    vm.editing = { file: '', title: 'VPN 常见问题', content: '# VPN\n连不上先重启', isNew: true }
    await vm.saveEdit()
    expect(state.files.get('knowledge/vpn-常见问题.md')).toContain('连不上先重启')
    const index = JSON.parse(state.files.get('knowledge/index.json')!)
    expect(index.docs).toHaveLength(1)
    expect(index.docs[0]).toMatchObject({ file: 'vpn-常见问题.md', title: 'VPN 常见问题', source: 'manual' })
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
    await seedIndex([
      { file: 'a.md', title: 'A', updatedAt: 'x' },
      { file: 'b.md', title: 'B', updatedAt: 'y' },
    ])
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

  it('清单条目带来源标识：沉淀/问答产物与手动文档同权（均可编辑下架）', async () => {
    await seedIndex([
      { file: 'a.md', title: '手动', updatedAt: 'x' },
      { file: 'b.md', title: '沉淀条目', updatedAt: 'x', source: 'extract' },
      { file: 'qa-archive/door/2026-10.md', title: '问答归档', updatedAt: 'x', source: 'qa' },
    ])
    state.files.set('knowledge/a.md', '1')
    state.files.set('knowledge/b.md', '2')
    const wrapper = mountCard()
    const vm = vmOf(wrapper)
    await vm.load()
    const store = useKnowledgeStore()
    expect(store.docs.map((doc) => doc.source)).toEqual(['manual', 'extract', 'qa'])
    // 沉淀条目同权下架
    await vm.offShelf({ file: 'b.md', title: '沉淀条目', updatedAt: 'x', source: 'extract' })
    expect(JSON.parse(state.files.get('knowledge/index.json')!).docs.map((d: { file: string }) => d.file)).toEqual([
      'a.md',
      'qa-archive/door/2026-10.md',
    ])
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

describe('welink/KnowledgeCard —— 待评审队列（knowledge-sedimentation 6.2）', () => {
  beforeEach(() => {
    state.platform = 'tauri'
    state.files = new Map()
    setActivePinia(createPinia())
    vi.clearAllMocks()
  })

  function queueHarness() {
    const wrapper = mountCard()
    const store = useKnowledgeStore()
    return { wrapper, store, vm: vmOf(wrapper) }
  }

  it('队列非空时渲染待评审区；通过（新建）走 store.approveDraft 并带编辑后内容', async () => {
    state.files.set('knowledge/index.json', JSON.stringify({ docs: [] }))
    const { wrapper, store, vm } = queueHarness()
    await vm.load()
    store.drafts = [
      {
        pk: 7,
        title: '门禁办理',
        content: '找行政前台。',
        topic: '门禁',
        sourceType: 'message',
        sourceRefs: ['m1'],
        contentHash: 'h1',
        status: 'pending',
        reviewNote: '',
        createdAt: 'x',
        reviewedAt: null,
      },
    ] as never
    await wrapper.vm.$nextTick()
    expect(wrapper.text()).toContain('待评审知识（1）')
    expect(wrapper.text()).toContain('门禁办理')

    const approveSpy = vi.spyOn(store, 'approveDraft').mockResolvedValue(true)
    vm.openReview({ pk: 7, title: '门禁办理', content: '找行政前台。', sourceType: 'message', sourceRefs: ['m1'] })
    vm.reviewing.mode = 'new'
    vm.reviewing.title = '门禁办理（修订）'
    await vm.approveDraft()
    expect(approveSpy).toHaveBeenCalledWith(7, { title: '门禁办理（修订）', content: '找行政前台。' }, undefined)
    expect(ElMessage.success).toHaveBeenCalled()
  })

  it('通过（并入）带目标文件；目标未选时被拦截提示', async () => {
    state.files.set(
      'knowledge/index.json',
      JSON.stringify({ docs: [{ file: 'door.md', title: '门禁手册', updatedAt: 'x' }] }),
    )
    const { store, vm } = queueHarness()
    await vm.load()
    const approveSpy = vi.spyOn(store, 'approveDraft').mockResolvedValue(true)

    vm.openReview({ pk: 1, title: '细则', content: '正文', sourceType: 'message', sourceRefs: [] })
    vm.reviewing.mode = 'append'
    vm.reviewing.targetFile = ''
    await vm.approveDraft()
    expect(approveSpy).not.toHaveBeenCalled()
    expect(ElMessage.warning).toHaveBeenCalledWith('请选择要并入的文档')

    vm.reviewing.targetFile = 'door.md'
    await vm.approveDraft()
    expect(approveSpy).toHaveBeenCalledWith(1, { title: '细则', content: '正文' }, { file: 'door.md' })
  })

  it('拒绝走 store.rejectDraft；队列清空后不渲染评审区', async () => {
    const { wrapper, store, vm } = queueHarness()
    await vm.load()
    const rejectSpy = vi.spyOn(store, 'rejectDraft').mockResolvedValue(true)
    vm.openReview({ pk: 3, title: '噪音', content: '闲聊', sourceType: 'message', sourceRefs: [] })
    await vm.rejectDraft({ pk: 3, title: '噪音' })
    expect(rejectSpy).toHaveBeenCalledWith(3, '人工拒绝')

    store.drafts = [] as never
    await wrapper.vm.$nextTick()
    expect(wrapper.text()).not.toContain('待评审知识')
  })

  it('store 拒绝失败（已被评审过）给出提示且不误报成功', async () => {
    const { store, vm } = queueHarness()
    await vm.load()
    vi.spyOn(store, 'rejectDraft').mockResolvedValue(false)
    vm.openReview({ pk: 3, title: '噪音', content: '闲聊', sourceType: 'message', sourceRefs: [] })
    await vm.rejectDraft({ pk: 3, title: '噪音' })
    expect(ElMessage.warning).toHaveBeenCalledWith('该条目已被评审过')
  })
})
