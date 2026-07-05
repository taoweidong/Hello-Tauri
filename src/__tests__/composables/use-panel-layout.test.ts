import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

// mock @vueuse/core 的 useBreakpoints
const mockBreakpointValues = { narrow: true, standard: false }
vi.mock('@vueuse/core', () => ({
  useBreakpoints: () => ({
    smaller: vi.fn((bp: string) => ({
      get value() { return mockBreakpointValues.narrow },
    })),
    between: vi.fn(() => ({
      get value() { return mockBreakpointValues.standard },
    })),
  }),
}))

import { usePanelLayout } from '@/composables/use-panel-layout'
import { useAppStore } from '@/stores/app'

describe('usePanelLayout', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('返回折叠状态和控制方法', () => {
    const layout = usePanelLayout()
    expect(layout.leftCollapsed).toBeDefined()
    expect(layout.rightCollapsed).toBeDefined()
    expect(typeof layout.collapseLeft).toBe('function')
    expect(typeof layout.expandLeft).toBe('function')
    expect(typeof layout.toggleLeft).toBe('function')
    expect(typeof layout.collapseRight).toBe('function')
    expect(typeof layout.expandRight).toBe('function')
    expect(typeof layout.toggleRight).toBe('function')
    expect(typeof layout.setLeftWidth).toBe('function')
    expect(typeof layout.setRightWidth).toBe('function')
  })

  it('collapseLeft / expandLeft 控制左侧面板折叠', () => {
    const layout = usePanelLayout()
    expect(layout.leftCollapsed.value).toBe(false)
    layout.collapseLeft()
    expect(layout.leftCollapsed.value).toBe(true)
    layout.expandLeft()
    expect(layout.leftCollapsed.value).toBe(false)
  })

  it('toggleLeft 切换左侧面板折叠状态', () => {
    const layout = usePanelLayout()
    layout.toggleLeft()
    expect(layout.leftCollapsed.value).toBe(true)
    layout.toggleLeft()
    expect(layout.leftCollapsed.value).toBe(false)
  })

  it('collapseRight / expandRight / toggleRight 控制右侧面板', () => {
    const layout = usePanelLayout()
    expect(layout.rightCollapsed.value).toBe(false)
    layout.collapseRight()
    expect(layout.rightCollapsed.value).toBe(true)
    layout.toggleRight()
    expect(layout.rightCollapsed.value).toBe(false)
    layout.toggleRight()
    expect(layout.rightCollapsed.value).toBe(true)
    layout.expandRight()
    expect(layout.rightCollapsed.value).toBe(false)
  })

  it('setLeftWidth 通过 store 设置左侧面板宽度', () => {
    const layout = usePanelLayout()
    const store = useAppStore()
    layout.setLeftWidth(350)
    expect(store.leftPanelWidth).toBe(350)
    expect(layout.leftWidth.value).toBe(350)
  })

  it('setRightWidth 通过 store 设置右侧面板宽度', () => {
    const layout = usePanelLayout()
    const store = useAppStore()
    layout.setRightWidth(400)
    expect(store.rightPanelWidth).toBe(400)
    expect(layout.rightWidth.value).toBe(400)
  })

  it('setLeftWidth 自动约束在允许范围内', () => {
    const layout = usePanelLayout()
    layout.setLeftWidth(50)   // 低于最小值 200
    expect(layout.leftWidth.value).toBe(200)
    layout.setLeftWidth(999)  // 超过最大值 400
    expect(layout.leftWidth.value).toBe(400)
  })

  it('setRightWidth 自动约束在允许范围内', () => {
    const layout = usePanelLayout()
    layout.setRightWidth(100)  // 低于最小值 240
    expect(layout.rightWidth.value).toBe(240)
    layout.setRightWidth(999)  // 超过最大值 500
    expect(layout.rightWidth.value).toBe(500)
  })

  it('autoCollapseRight 在窄屏下为 true', () => {
    const layout = usePanelLayout()
    // mock 中 isNarrow 为 true
    expect(layout.autoCollapseRight.value).toBe(true)
  })

  it('isNarrow 和 isStandard 响应式断点可用', () => {
    const layout = usePanelLayout()
    expect(layout.isNarrow).toBeDefined()
    expect(layout.isStandard).toBeDefined()
  })
})
