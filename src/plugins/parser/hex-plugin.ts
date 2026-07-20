import { defineComponent, h } from 'vue'
import type { IFileParserPlugin } from '../types'
import { useTabManager } from '@/composables/use-tabs'

/** Hex 查看器最大渲染行数，超出后截断以防止大文件卡死 */
const MAX_HEX_LINES = 10000

/** Hex 查看器渲染组件，以偏移量 + 十六进制 + ASCII 格式展示二进制数据 */
const HexRenderer = defineComponent({
  name: 'HexRenderer',
  props: {
    content: { required: true },
  },
  setup(props) {
    const { globalFontSize } = useTabManager()
    return () => {
      const data = props.content as Uint8Array
      const bytesPerLine = 16
      const maxBytes = MAX_HEX_LINES * bytesPerLine
      const truncated = data.length > maxBytes
      const displayData = truncated ? data.slice(0, maxBytes) : data
      const lines: string[] = []
      for (let i = 0; i < displayData.length; i += bytesPerLine) {
        const slice = displayData.slice(i, i + bytesPerLine)
        const hex = Array.from(slice).map(b => b.toString(16).padStart(2, '0')).join(' ')
        const ascii = Array.from(slice).map(b => b >= 32 && b < 127 ? String.fromCharCode(b) : '.').join('')
        const offset = i.toString(16).padStart(8, '0')
        lines.push(`${offset}  ${hex.padEnd(47)}  ${ascii}`)
      }
      if (truncated) {
        lines.push(`\n… 仅显示前 ${MAX_HEX_LINES} 行 (${(maxBytes / 1048576).toFixed(1)} MB)，共 ${Math.ceil(data.length / bytesPerLine)} 行`)
      }
      return h('pre', {
        style: {
          fontFamily: '"JetBrains Mono", monospace',
          fontSize: `${globalFontSize.value}px`,
          padding: '8px',
          overflow: 'auto',
          height: '100%',
          margin: 0,
          background: 'var(--color-editor-bg)',
          color: 'var(--color-editor-text)',
        }
      }, lines.join('\n'))
    }
  }
})

/** 十六进制解析插件，仅在用户显式选择"以 Hex 查看"时启用，不再作为未知文件的默认兜底 */
export const hexPlugin: IFileParserPlugin = {
  name: 'hex',
  supportedExtensions: [],
  canParse() {
    // 不再无条件返回 true，避免未知文件被伪装成"可展示"
    // 仅在用户显式选择 Hex 查看时通过外部调用 parse()
    return false
  },
  async parse(data: Uint8Array) {
    return {
      type: 'hex' as const,
      data: data,
      lineCount: Math.ceil(data.length / 16),
    }
  },
  getComponent() {
    return HexRenderer
  },
}
