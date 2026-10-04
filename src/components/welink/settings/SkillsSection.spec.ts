import { mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 「回复技能」分区契约测试（skill-routing 设计 §10）。
 *
 * EP 表单组件整体桩掉后 v-model 不可交互，因此编辑器草稿经暴露的 `editingDraft`
 * 驱动（见组件 defineExpose 注释），列表操作走暴露的同名函数 —— 断言的是
 * 「操作 → agent.skills 整字段更新」的对外契约，而不是内部实现。
 *
 * 双向绑定断言用本地捕获的 `current()` 而不是 `wrapper.props`：update:modelValue
 * 的监听器里同步 setProps 读 props 仍是旧值（与真实父级「ref 赋值 → 下个 tick
 * 成为新 prop」同构，捕获变量正是真实父级的 draft ref）。
 */
vi.mock('element-plus', () => ({
  ElMessage: { success: vi.fn(), warning: vi.fn(), error: vi.fn() },
}))

import { ElMessage } from 'element-plus'
import { DEFAULT_WELINK_SETTINGS, MAX_WELINK_SKILLS, type WelinkSettings, type WelinkSkill } from '@/types/welink'
import SkillsSection from './SkillsSection.vue'

const EP_STUBS = [
  'el-collapse-item',
  'el-switch',
  'el-button',
  'el-tag',
  'el-form',
  'el-form-item',
  'el-input',
  'el-alert',
]

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
    global: { stubs: Object.fromEntries(EP_STUBS.map((name) => [name, true])) },
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

  it('到达数量上限后「添加技能」被拦截并提示', () => {
    const full = Array.from({ length: MAX_WELINK_SKILLS }, (_, index) =>
      baseSkill({ id: `s${index}`, name: `技能${index}` }),
    )
    const h = mountSection(full)
    ;(h.wrapper.vm as unknown as { startAdd: () => void }).startAdd()
    expect(ElMessage.warning).toHaveBeenCalled()
  })
})
