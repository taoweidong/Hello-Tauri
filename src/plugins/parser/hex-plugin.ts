import { defineComponent, h } from 'vue'
import type { IFileParserPlugin } from '../types'
import { useTabManager } from '@/composables/use-tabs'

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
      const lines: string[] = []
      const bytesPerLine = 16
      for (let i = 0; i < data.length; i += bytesPerLine) {
        const slice = data.slice(i, i + bytesPerLine)
        const hex = Array.from(slice).map(b => b.toString(16).padStart(2, '0')).join(' ')
        const ascii = Array.from(slice).map(b => b >= 32 && b < 127 ? String.fromCharCode(b) : '.').join('')
        const offset = i.toString(16).padStart(8, '0')
        lines.push(`${offset}  ${hex.padEnd(47)}  ${ascii}`)
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

/** 十六进制解析插件，作为未知格式的兆底解析器，以 Hex 视图展示原始字节 */
export const hexPlugin: IFileParserPlugin = {
  name: 'hex',
  supportedExtensions: [],
  canParse() {
    return true
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
