import { ref, computed } from 'vue'
import { useBreakpoints } from '@vueuse/core'
import { useAppStore } from '@/stores/app'
import {
  MIN_LEFT_PANEL_WIDTH,
  MAX_LEFT_PANEL_WIDTH,
  MIN_RIGHT_PANEL_WIDTH,
  MAX_RIGHT_PANEL_WIDTH,
} from '@/config'

/** 左侧面板是否已折叠（模块级单例） */
const leftCollapsed = ref(false)
/** 右侧面板是否已折叠（模块级单例） */
const rightCollapsed = ref(false)

/** 响应式断点配置 */
const breakpoints = useBreakpoints({
  narrow: 0,
  standard: 1200,
  wide: 1400,
})

const isNarrow = breakpoints.smaller('standard')
const isStandard = breakpoints.between('standard', 'wide')

/** 面板布局管理 composable，提供折叠、宽度、响应式断点控制 */
export function usePanelLayout() {
  const store = useAppStore()

  /** 折叠左侧面板 */
  function collapseLeft() { leftCollapsed.value = true }
  /** 展开左侧面板 */
  function expandLeft() { leftCollapsed.value = false }
  /** 切换左侧面板折叠状态 */
  function toggleLeft() { leftCollapsed.value = !leftCollapsed.value }
  /** 折叠右侧面板 */
  function collapseRight() { rightCollapsed.value = true }
  /** 展开右侧面板 */
  function expandRight() { rightCollapsed.value = false }
  /** 切换右侧面板折叠状态 */
  function toggleRight() { rightCollapsed.value = !rightCollapsed.value }
  /**
   * 设置左侧面板宽度
   * @param w - 目标宽度（像素）
   */
  function setLeftWidth(w: number) { store.setLeftPanelWidth(w) }
  /**
   * 设置右侧面板宽度
   * @param w - 目标宽度（像素）
   */
  function setRightWidth(w: number) { store.setRightPanelWidth(w) }

  /** 是否应自动折叠右侧面板（窄屏/标准屏） */
  const autoCollapseRight = computed(() => isNarrow.value || isStandard.value)

  return {
    leftCollapsed, rightCollapsed,
    leftWidth: computed(() => store.leftPanelWidth),
    rightWidth: computed(() => store.rightPanelWidth),
    isNarrow, isStandard,
    autoCollapseRight,
    collapseLeft, expandLeft, toggleLeft,
    collapseRight, expandRight, toggleRight,
    setLeftWidth, setRightWidth,
  }
}
