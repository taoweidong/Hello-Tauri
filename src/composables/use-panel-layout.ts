import { ref, computed } from 'vue'
import { useBreakpoints } from '@vueuse/core'

const leftCollapsed = ref(false)
const rightCollapsed = ref(false)
const leftWidth = ref(280)
const rightWidth = ref(300)

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
  function collapseRight() { rightCollapsed.value = true }
  function expandRight() { rightCollapsed.value = false }
  function setLeftWidth(w: number) { leftWidth.value = Math.max(200, Math.min(400, w)) }
  function setRightWidth(w: number) { rightWidth.value = Math.max(240, Math.min(500, w)) }

  const autoCollapseRight = computed(() => isNarrow.value || isStandard.value)

  return {
    leftCollapsed, rightCollapsed,
    leftWidth, rightWidth,
    isNarrow, isStandard,
    autoCollapseRight,
    collapseLeft, expandLeft,
    collapseRight, expandRight,
    setLeftWidth, setRightWidth,
  }
}
