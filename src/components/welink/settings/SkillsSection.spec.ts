import { mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * EP 表单组件整体桩掉后 v-model 不可交互，因此编辑器草稿经暴露的 `editingDraft`
 * 驱动（见组件 defineExpose 注释），列表操作走暴露的同名函数 —— 断言的是
 * 「操作 → agent.skills 整字段更新」的对外契约，而不是内部实现。
 *
 * `el-collapse-item` 用**渲染 slot 的桩**而不是空桩：分区全部内容都在它的默认
 * slot 里，空桩会把整棵子树吞掉，任何 DOM 断言都会失真（回归钉用例因此假红过）。
 * 双向绑定断言用本地捕获的 `current()` 而不是 `wrapper.props`：update:modelValue
 * 的监听器里同步 setProps 读 props 仍是旧值（与真实父级「ref 赋值 → 下个 tick
 * 成为新 prop」同构，捕获变量正是真实父级的 draft ref）。
 */
vi.mock('element-plus', () => ({
  ElMessage: { success: vi.fn(), warning: vi.fn(), error: vi.fn() },
}))

// 知识文档多选的数据源来自 knowledge store：这里给最小假件（列表为空即可，
// 编辑断言直接驱动 editingDraft.knowledgeDocs，不依赖下拉交互）
vi.mock('@/stores/welink/knowledge', () => ({
  useKnowledgeStore: () => ({ docs: [], loadDocs: async () => undefined }),
}))

import { ElMessage } from 'element-plus'
import {
  DEFAULT_WELINK_SETTINGS,
  MAX_WELINK_SKILLS,
  PROMPT_PLACEHOLDERS,
  type WelinkSettings,
  type WelinkSkill,
} from '@/types/welink'
import SkillsSection from './SkillsSection.vue'

const EP_STUBS: Record<string, unknown> = {
  'el-collapse-item': { template: '<div><slot /></div>' },
  'el-switch': true,
  'el-button': true,
  'el-tag': true,
  'el-form': true,
  'el-form-item': true,
  'el-input': true,
  'el-alert': true,
}

function baseSkill(overrides: Partial<WelinkSkill> = {}): WelinkSkill {
  return {
    id: 'a',
    name: '故障咨询',
    description: '报错类问题',
    enabled: true,
    keywords: ['报错'],
    promptTemplate: '',
    knowledge: '',
    reviewMode: 'auto',
    retrieval: { enabled: false },
    knowledgeDocs: [],
    ...overrides,
  }
}

function mountSection(skills: WelinkSkill[], llmClassifyFallback = true) {
  let current: WelinkSettings['agent'] = { ...DEFAULT_WELINK_SETTINGS.agent, skills, llmClassifyFallback }
  const wrapper = mount(SkillsSection, {
    props: {
      modelValue: current,
      'onUpdate:modelValue': (value: WelinkSettings['agent']) => {
        current = value
        void wrapper.setProps({ modelValue: value })
      },
    },
    global: { stubs: EP_STUBS as never },
  })
  return { wrapper, current: () => current }
}

/** 编辑器当前草稿（defineModel 的 exposed ref 自动解包，可直接整对象赋值） */
function draftOf(harness: ReturnType<typeof mountSection>): WelinkSkill {
  return (harness.wrapper.vm as unknown as { editingDraft: WelinkSkill }).editingDraft
}

describe('welink/settings/SkillsSection（回复技能分区）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('新增：无名称被拦截不写入；有名称保存进清单（id 留空交归一化分配）', () => {
    const h = mountSection([])
    const vm = h.wrapper.vm as unknown as Record<string, (...args: unknown[]) => void>
    vm.startAdd()
    vm.saveEditor()
    expect(ElMessage.warning).toHaveBeenCalled()
    expect(h.current().skills).toHaveLength(0)

    vm.startAdd()
    ;(h.wrapper.vm as unknown as { editingDraft: WelinkSkill }).editingDraft = {
      ...draftOf(h),
      name: '进度查询',
    }
    vm.saveEditor()
    const skills = h.current().skills
    expect(skills).toHaveLength(1)
    expect(skills[0]).toMatchObject({ id: '', name: '进度查询', reviewMode: 'auto' })
    expect(ElMessage.warning).toHaveBeenCalledTimes(1)
  })

  it('startAdd 后编辑器必须出现在 DOM（回归钉：新建态不在 v-for 行内，曾因行内匹配漏渲染）', async () => {
    const h = mountSection([])
    ;(h.wrapper.vm as unknown as { startAdd: () => void }).startAdd()
    await h.wrapper.vm.$nextTick()
    expect(h.wrapper.findAll('.sk__edit').length).toBe(1)
    expect(h.wrapper.find('.sk__edit').text()).toContain('新建技能')

    // 保存后编辑器收起；编辑既有技能时标题带名称
    ;(h.wrapper.vm as unknown as { editingDraft: WelinkSkill }).editingDraft = {
      ...draftOf(h),
      name: '进度查询',
    }
    ;(h.wrapper.vm as unknown as { saveEditor: () => void }).saveEditor()
    await h.wrapper.vm.$nextTick()
    expect(h.wrapper.findAll('.sk__edit').length).toBe(0)
    ;(h.wrapper.vm as unknown as { startEdit: (s: WelinkSkill) => void }).startEdit(h.current().skills[0])
    await h.wrapper.vm.$nextTick()
    expect(h.wrapper.find('.sk__edit').text()).toContain('编辑：进度查询')
  })

  it('编辑现有技能：原 id 原位替换（不新增条目）', () => {
    const h = mountSection([baseSkill()])
    const vm = h.wrapper.vm as unknown as Record<string, (...args: unknown[]) => void>
    vm.startEdit(baseSkill())
    ;(h.wrapper.vm as unknown as { editingDraft: WelinkSkill }).editingDraft = {
      ...draftOf(h),
      name: '故障排查',
      keywords: ['报错', '/异常/'],
    }
    vm.saveEditor()
    const skills = h.current().skills
    expect(skills).toHaveLength(1)
    expect(skills[0]).toMatchObject({ id: 'a', name: '故障排查', keywords: ['报错', '/异常/'] })
  })

  it('启停与删除：整字段替换，其余技能保持不动', () => {
    const h = mountSection([baseSkill(), baseSkill({ id: 'b', name: '进度查询' })])
    const vm = h.wrapper.vm as unknown as Record<string, (...args: unknown[]) => void>
    vm.setEnabled('a', false)
    let skills = h.current().skills
    expect(skills.find((skill) => skill.id === 'a')?.enabled).toBe(false)
    expect(skills.find((skill) => skill.id === 'b')?.enabled).toBe(true)

    vm.removeSkill('a')
    skills = h.current().skills
    expect(skills.map((skill) => skill.id)).toEqual(['b'])
  })

  it('上移/下移调整匹配优先级（数组顺序 = 规则命中顺序）', async () => {
    const h = mountSection([baseSkill(), baseSkill({ id: 'b', name: '进度查询' })])
    const vm = h.wrapper.vm as unknown as Record<string, (...args: unknown[]) => void>
    vm.move('b', -1)
    expect(h.current().skills.map((skill) => skill.id)).toEqual(['b', 'a'])
    // 等父级 props 落定（真实父级里 draft 回写发生在下个 tick），再做下一次操作
    await h.wrapper.vm.$nextTick()
    vm.move('b', 1)
    expect(h.current().skills.map((skill) => skill.id)).toEqual(['a', 'b'])
  })

  it('技能检索绑定随编辑器保存（rag-retrieval）：enabled/filter 透传到 skills', async () => {
    const h = mountSection([baseSkill()])
    const vm = h.wrapper.vm as unknown as Record<string, (...args: unknown[]) => void>
    vm.startEdit(baseSkill())
    ;(h.wrapper.vm as unknown as { editingDraft: WelinkSkill }).editingDraft = {
      ...draftOf(h),
      retrieval: { enabled: true, filter: ' 故障 ' },
    }
    vm.saveEditor()
    const saved = h.current().skills[0]
    // filter 的 trim 收敛在父级 normalizeWelinkSettings（types 层已钉），组件层透传原值
    expect(saved.retrieval).toEqual({ enabled: true, filter: ' 故障 ' })
  })

  it('新建技能草稿默认不检索（rag-retrieval 零迁移语义）', async () => {
    const h = mountSection([])
    const vm = h.wrapper.vm as unknown as Record<string, (...args: unknown[]) => void>
    vm.startAdd()
    expect((h.wrapper.vm as unknown as { editingDraft: WelinkSkill }).editingDraft.retrieval).toEqual({
      enabled: false,
    })
  })

  it('到达数量上限后「添加技能」被拦截并提示', () => {
    const full = Array.from({ length: MAX_WELINK_SKILLS }, (_, index) =>
      baseSkill({ id: `s${index}`, name: `技能${index}` }),
    )
    const h = mountSection(full)
    ;(h.wrapper.vm as unknown as { startAdd: () => void }).startAdd()
    expect(ElMessage.warning).toHaveBeenCalled()
  })
})

describe('welink/settings/SkillsSection —— 知识文档绑定（knowledge-sedimentation 6.3）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('知识文档绑定随草稿保存进技能（上限内整字段更新）', () => {
    const h = mountSection([])
    const vm = h.wrapper.vm as unknown as {
      startAdd: () => void
      editingDraft: WelinkSkill | null
      saveEditor: () => void
    }
    vm.startAdd()
    if (!vm.editingDraft) throw new Error('编辑器未打开')
    vm.editingDraft.name = '门禁助手'
    vm.editingDraft.knowledgeDocs = ['door.md', 'contact.md']
    vm.saveEditor()
    expect(h.current().skills).toHaveLength(1)
    expect(h.current().skills[0].knowledgeDocs).toEqual(['door.md', 'contact.md'])
  })

  it('模板占位符 tag 含 {{docs}}（本地知识文档口径入口可见；tag 行直接映射该常量）', () => {
    expect(PROMPT_PLACEHOLDERS).toContain('{{docs}}')
  })
})
