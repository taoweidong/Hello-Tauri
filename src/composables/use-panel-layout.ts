import { ref, computed } from 'vue'
import { useBreakpoints } from '@vueuse/core'
import {
  DEFAULT_LEFT_PANEL_WIDTH,
  DEFAULT_RIGHT_PANEL_WIDTH,
  MIN_LEFT_PANEL_WIDTH,
  MAX_LEFT_PANEL_WIDTH,
  MIN_RIGHT_PANEL_WIDTH,
  MAX_RIGHT_PANEL_WIDTH,
} from '@/config'

const leftCollapsed = ref(false)
const rightCollapsed = ref(false)
const leftWidth = ref(DEFAULT_LEFT_PANEL_WIDTH)
const rightWidth = ref(DEFAULT_RIGHT_PANEL_WIDTH)

const breakpoints = useBreakpoints({
  narrow: 0,
  standard: 1200,
  wide: 1400,
})

const isNarrow = breakpoints.smaller('standard')
const isStandard = breakpoints.between('standard', 'wide')

export function usePanelLayout() {
  function collapseLeft() { leftCollapsed.value = true }
  function expandLeft() { leftCollapsed.value = false }
  function toggleLeft() { leftCollapsed.value = !leftCollapsed.value }
  function collapseRight() { rightCollapsed.value = true }
  function expandRight() { rightCollapsed.value = false }
  function toggleRight() { rightCollapsed.value = !rightCollapsed.value }
  function setLeftWidth(w: number) { leftWidth.value = Math.max(MIN_LEFT_PANEL_WIDTH, Math.min(MAX_LEFT_PANEL_WIDTH, w)) }
  function setRightWidth(w: number) { rightWidth.value = Math.max(MIN_RIGHT_PANEL_WIDTH, Math.min(MAX_RIGHT_PANEL_WIDTH, w)) }

  const autoCollapseRight = computed(() => isNarrow.value || isStandard.value)

  return {
    leftCollapsed, rightCollapsed,
    leftWidth, rightWidth,
    isNarrow, isStandard,
    autoCollapseRight,
    collapseLeft, expandLeft, toggleLeft,
    collapseRight, expandRight, toggleRight,
    setLeftWidth, setRightWidth,
  }
}
