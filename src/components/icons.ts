import { defineComponent, h } from 'vue'
import type { Component } from 'vue'

/**
 * 内联 SVG 图标系统。零 CDN、零在线字体、零图标依赖 —— 每个图标都是随源码打包的
 * 24×24 描边矢量，currentColor 跟随文字色。
 */
type Shape = [tag: string, attrs: Record<string, string | number>]

const SHAPES: Record<string, Shape[]> = {
  grid: [
    ['rect', { x: 3, y: 3, width: 7, height: 7, rx: 1.5 }],
    ['rect', { x: 14, y: 3, width: 7, height: 7, rx: 1.5 }],
    ['rect', { x: 14, y: 14, width: 7, height: 7, rx: 1.5 }],
    ['rect', { x: 3, y: 14, width: 7, height: 7, rx: 1.5 }],
  ],
  table: [
    ['rect', { x: 3, y: 4, width: 18, height: 16, rx: 2 }],
    ['path', { d: 'M3 9h18M3 14h18M9 4v16' }],
  ],
  sliders: [
    ['path', { d: 'M4 6h11M18 6h2M4 12h2M9 12h11M4 18h9M16 18h4' }],
    ['circle', { cx: 16, cy: 6, r: 2 }],
    ['circle', { cx: 7, cy: 12, r: 2 }],
    ['circle', { cx: 14, cy: 18, r: 2 }],
  ],
  info: [
    ['circle', { cx: 12, cy: 12, r: 9 }],
    ['path', { d: 'M12 11v5M12 8h.01' }],
  ],
  sun: [
    ['circle', { cx: 12, cy: 12, r: 4 }],
    ['path', { d: 'M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M19.1 4.9l-1.4 1.4M6.3 17.7l-1.4 1.4' }],
  ],
  moon: [['path', { d: 'M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z' }]],
  panelLeft: [
    ['rect', { x: 3, y: 4, width: 18, height: 16, rx: 2 }],
    ['path', { d: 'M9 4v16' }],
    ['path', { d: 'M6 10v4' }],
  ],
  search: [
    ['circle', { cx: 11, cy: 11, r: 7 }],
    ['path', { d: 'M20 20l-3.2-3.2' }],
  ],
  plus: [['path', { d: 'M12 5v14M5 12h14' }]],
  trash: [
    ['path', { d: 'M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13' }],
    ['path', { d: 'M10 11v6M14 11v6' }],
  ],
  refresh: [
    ['path', { d: 'M20 11a8 8 0 0 0-13.7-5.3L3 9M4 13a8 8 0 0 0 13.7 5.3L21 15' }],
    ['path', { d: 'M3 4v5h5M21 20v-5h-5' }],
  ],
  restore: [
    ['path', { d: 'M3 12a9 9 0 1 0 3-6.7L3 8' }],
    ['path', { d: 'M3 3v5h5' }],
  ],
  download: [['path', { d: 'M12 3v12m0 0l-4-4m4 4l4-4M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2' }]],
  folder: [
    ['path', { d: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z' }],
  ],
  check: [['path', { d: 'M20 6L9 17l-5-5' }]],
  database: [
    ['ellipse', { cx: 12, cy: 5, rx: 8, ry: 3 }],
    ['path', { d: 'M4 5v6c0 1.7 3.6 3 8 3s8-1.3 8-3V5' }],
    ['path', { d: 'M4 11v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6' }],
  ],
  layers: [
    ['path', { d: 'M12 3l9 5-9 5-9-5 9-5z' }],
    ['path', { d: 'M3 13l9 5 9-5M3 16.5l9 5 9-5' }],
  ],
  user: [
    ['circle', { cx: 12, cy: 8, r: 4 }],
    ['path', { d: 'M4 21a8 8 0 0 1 16 0' }],
  ],
  clock: [
    ['circle', { cx: 12, cy: 12, r: 9 }],
    ['path', { d: 'M12 7v5l3 2' }],
  ],
  chevronRight: [['path', { d: 'M9 6l6 6-6 6' }]],
  arrowRight: [['path', { d: 'M5 12h14m0 0l-6-6m6 6l-6 6' }]],
  x: [['path', { d: 'M6 6l12 12M18 6L6 18' }]],
  activity: [['path', { d: 'M3 12h4l3 8 4-16 3 8h4' }]],
  tag: [
    ['path', { d: 'M3 12V4a1 1 0 0 1 1-1h8l9 9-9 9z' }],
    ['circle', { cx: 8, cy: 8, r: 1.4 }],
  ],
  box: [
    ['path', { d: 'M21 8l-9-5-9 5 9 5 9-5z' }],
    ['path', { d: 'M3 8v8l9 5 9-5V8M12 13v8' }],
  ],
  coin: [
    ['circle', { cx: 12, cy: 12, r: 9 }],
    ['path', { d: 'M12 7v10M9.5 9.5A2 2 0 0 1 12 8.5c1.5 0 2.3.7 2.3 1.7 0 2.3-4.6 1.2-4.6 3.6 0 1 .8 1.7 2.3 1.7a2 2 0 0 0 2.2-1.1' }],
  ],
  filter: [['path', { d: 'M3 5h18l-7 8v6l-4-2v-4z' }]],
  alert: [
    ['path', { d: 'M12 3.5L1.8 20.5h20.4z' }],
    ['path', { d: 'M12 10v4M12 17.5h.01' }],
  ],
  palette: [
    ['path', { d: 'M12 3a9 9 0 1 0 0 18c1 0 1.6-.8 1.6-1.6 0-.5-.2-.8-.5-1.1-.3-.3-.5-.7-.5-1.1 0-.9.7-1.6 1.6-1.6H16a5 5 0 0 0 5-5c0-4.4-4-7.6-9-7.6z' }],
    ['circle', { cx: 7.5, cy: 10.5, r: 1 }],
    ['circle', { cx: 12, cy: 7.5, r: 1 }],
    ['circle', { cx: 16.5, cy: 10.5, r: 1 }],
  ],
}

export type IconName = keyof typeof SHAPES

function makeIcon(name: IconName, weight = 1.75): Component {
  const shapes = SHAPES[name]
  return defineComponent({
    name: `Icon${name[0].toUpperCase()}${name.slice(1)}`,
    props: { size: { type: [Number, String], default: undefined } },
    setup(_, { attrs }) {
      return () =>
        h(
          'svg',
          {
            viewBox: '0 0 24 24',
            width: '1em',
            height: '1em',
            fill: 'none',
            stroke: 'currentColor',
            'stroke-width': weight,
            'stroke-linecap': 'round',
            'stroke-linejoin': 'round',
            'aria-hidden': 'true',
            ...attrs,
          },
          shapes.map(([tag, a]) => h(tag, a)),
        )
    },
  })
}

export const IconGrid = makeIcon('grid')
export const IconTable = makeIcon('table')
export const IconSliders = makeIcon('sliders')
export const IconInfo = makeIcon('info')
export const IconSun = makeIcon('sun')
export const IconMoon = makeIcon('moon')
export const IconPanelLeft = makeIcon('panelLeft')
export const IconSearch = makeIcon('search')
export const IconPlus = makeIcon('plus')
export const IconTrash = makeIcon('trash')
export const IconRefresh = makeIcon('refresh')
export const IconRestore = makeIcon('restore')
export const IconDownload = makeIcon('download')
export const IconFolder = makeIcon('folder')
export const IconCheck = makeIcon('check')
export const IconDatabase = makeIcon('database')
export const IconLayers = makeIcon('layers')
export const IconUser = makeIcon('user')
export const IconClock = makeIcon('clock')
export const IconChevronRight = makeIcon('chevronRight')
export const IconArrowRight = makeIcon('arrowRight')
export const IconX = makeIcon('x')
export const IconActivity = makeIcon('activity')
export const IconTag = makeIcon('tag')
export const IconBox = makeIcon('box')
export const IconCoin = makeIcon('coin')
export const IconFilter = makeIcon('filter')
export const IconPalette = makeIcon('palette')
export const IconAlert = makeIcon('alert')

/** 通用图标组件：<AppIcon name="grid" />，用于模板里动态选图 */
const iconCache = new Map<IconName, Component>()
function iconOf(name: IconName): Component {
  let c = iconCache.get(name)
  if (!c) {
    c = makeIcon(name)
    iconCache.set(name, c)
  }
  return c
}

export const AppIcon = defineComponent({
  name: 'AppIcon',
  props: { name: { type: String as () => IconName, required: true } },
  setup(props) {
    return () => h(iconOf(props.name))
  },
})