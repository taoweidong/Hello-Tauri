import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'

import type { CodeHubMrRecord, CodeHubMrState } from '@/types/codehub'
import { CODEHUB_STATE_LABEL } from '@/types/codehub'
import MrDetailPanel from './MrDetailPanel.vue'
import MrStateBadge from './MrStateBadge.vue'

/**
 * MR 详情面板与状态徽标（personal-workbench）。
 *
 * 徽标的存在意义是「三态文案只有一份真值」，所以这里把它和面板放在一起测：
 * 面板不再自带标签映射，读到的仍是同一段文案；缺详情走占位而不是空白崩页。
 */

const STATES: CodeHubMrState[] = ['open', 'merged', 'closed']

function record(withDetail = true): CodeHubMrRecord {
  return {
    summary: {
      repoId: 'demo/a',
      mrIid: '101',
      title: '支持内网 MR 快照',
      state: 'open',
      author: 'someone',
      sourceBranch: 'feat/codehub',
      targetBranch: 'main',
      updatedAt: '2026-10-02 10:00:00',
      webUrl: '',
      review: { reviewers: ['张三', '李四'], approvals: 1, unresolved: 2, lastActivityAt: '2026-10-02 09:00:00' },
    },
    detail: withDetail
      ? { description: '正文描述', comments: [{ author: '张三', body: '这里要加测试', createdAt: '2026-10-02 09:30:00' }] }
      : null,
  }
}

describe('MrStateBadge', () => {
  it.each([
    ['open', '开启'],
    ['merged', '已合并'],
    ['closed', '已关闭'],
  ] as const)('%s 渲染为「%s」', (state, label) => {
    const wrapper = mount(MrStateBadge, { props: { state } })
    expect(wrapper.text()).toBe(label)
    expect(wrapper.classes()).toContain(`mr-state--${state}`)
  })
})

describe('MrDetailPanel', () => {
  it('完整详情：标题、键值与检视意见都来自传入的记录', () => {
    const wrapper = mount(MrDetailPanel, { props: { record: record() } })
    expect(wrapper.get('.detail__title').text()).toBe('支持内网 MR 快照')
    expect(wrapper.get('.detail__desc').text()).toContain('正文描述')
    expect(wrapper.text()).toContain('demo/a')
    expect(wrapper.text()).toContain('feat/codehub → main')
    expect(wrapper.text()).toContain('1 赞成 · 2 未解决')
    expect(wrapper.findAll('.detail__comment')).toHaveLength(1)
    expect(wrapper.get('.detail__comment-body').text()).toBe('这里要加测试')
  })

  it('三态徽标与列表页同一份文案（面板不再自带标签映射）', () => {
    for (const state of STATES) {
      const base = record()
      base.summary.state = state
      const badge = mount(MrDetailPanel, { props: { record: base } }).get('.mr-state')
      expect(badge.text()).toBe(CODEHUB_STATE_LABEL[state])
    }
  })

  it('缺详情：loading 与「无载荷」两种占位文案，且不发任何调用', () => {
    const loading = mount(MrDetailPanel, { props: { record: record(false), loading: true } })
    expect(loading.get('.detail__missing').text()).toContain('详情补拉中')

    const idle = mount(MrDetailPanel, { props: { record: record(false) } })
    expect(idle.get('.detail__missing').text()).toContain('快照中无详情载荷')
    expect(idle.find('.detail__desc').exists()).toBe(false)
  })

  it('空详情载荷：合法的空评论显示「暂无检视意见」而不是缺详情', () => {
    const empty = record()
    empty.detail = { description: '', comments: [] }
    const wrapper = mount(MrDetailPanel, { props: { record: empty } })
    expect(wrapper.find('.detail__missing').exists()).toBe(false)
    expect(wrapper.get('.detail__nocomment').text()).toContain('暂无检视意见')
  })

  it('关闭按钮派发 close 事件（面板自己不改状态）', async () => {
    const wrapper = mount(MrDetailPanel, { props: { record: record() } })
    await wrapper.get('.detail__close').trigger('click')
    expect(wrapper.emitted('close')).toHaveLength(1)
  })

  it('record 为 null 时整块不渲染', () => {
    const wrapper = mount(MrDetailPanel, { props: { record: null } })
    expect(wrapper.find('.detail').exists()).toBe(false)
  })
})
