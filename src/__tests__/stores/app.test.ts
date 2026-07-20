import { describe, it, expect, beforeEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useAppStore } from '@/stores/app'

describe('useAppStore', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('toggles theme', () => {
    const store = useAppStore()
    expect(store.isDarkTheme).toBe(true)
    store.toggleTheme()
    expect(store.isDarkTheme).toBe(false)
  })

  it('clamps left panel width', () => {
    const store = useAppStore()
    store.setLeftPanelWidth(100)
    expect(store.leftPanelWidth).toBe(200)
    store.setLeftPanelWidth(500)
    expect(store.leftPanelWidth).toBe(400)
    store.setLeftPanelWidth(300)
    expect(store.leftPanelWidth).toBe(300)
  })

  it('clamps right panel width', () => {
    const store = useAppStore()
    store.setRightPanelWidth(100)
    expect(store.rightPanelWidth).toBe(240)
    store.setRightPanelWidth(600)
    expect(store.rightPanelWidth).toBe(500)
    store.setRightPanelWidth(350)
    expect(store.rightPanelWidth).toBe(350)
  })
})
