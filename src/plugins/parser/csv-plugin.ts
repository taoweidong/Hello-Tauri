import { defineComponent, h } from 'vue'
import type { IFileParserPlugin, ConfigSchema } from '../types'

const CsvRenderer = defineComponent({
  name: 'CsvRenderer',
  props: {
    content: { type: Object, required: true },
    fontSize: { type: Number, default: 14 },
    fixedHeader: { type: Boolean, default: true },
  },
  setup(props) {
    return () => {
      const { headers, rows } = props.content as { headers: string[]; rows: string[][] }
      const headerStyle = {
        border: '1px solid #333',
        padding: '4px 8px',
        ...(props.fixedHeader ? { position: 'sticky' as const, top: 0, background: '#1a1a2e' } : {}),
      }
      return h('div', { style: { overflow: 'auto', height: '100%' } }, [
        h('table', {
          style: {
            borderCollapse: 'collapse',
            width: '100%',
            fontSize: `${props.fontSize}px`,
            fontFamily: '"JetBrains Mono", monospace',
          }
        }, [
          h('thead', h('tr', headers.map((header, i) =>
            h('th', {
              key: i,
              style: headerStyle,
            }, header)
          ))),
          h('tbody', rows.map((row, ri) =>
            h('tr', { key: ri }, row.map((cell, ci) =>
              h('td', {
                key: ci,
                style: { border: '1px solid #333', padding: '4px 8px' }
              }, cell)
            ))
          )),
        ])
      ])
    }
  }
})

function parseCsv(text: string, delimiter: string): { headers: string[]; rows: string[][] } {
  const lines = text.split('\n').filter(line => line.trim().length > 0)
  if (lines.length === 0) return { headers: [], rows: [] }
  const headers = lines[0].split(delimiter).map(s => s.trim())
  const rows = lines.slice(1).map(line => line.split(delimiter).map(s => s.trim()))
  return { headers, rows }
}

export const csvPlugin: IFileParserPlugin = {
  name: 'csv',
  supportedExtensions: ['.csv', '.tsv'],
  canParse(file) {
    return this.supportedExtensions.some(ext => file.name.endsWith(ext))
  },
  async parse(data: Uint8Array, options?: Record<string, any>) {
    const text = new TextDecoder('utf-8').decode(data)
    const delimiter = options?.delimiter ?? ','
    const parsed = parseCsv(text, delimiter)
    return {
      type: 'csv' as const,
      data: parsed,
      lineCount: parsed.rows.length + 1,
    }
  },
  getComponent() {
    return CsvRenderer
  },
  getConfigSchema(): ConfigSchema {
    return {
      fields: [
        { key: 'delimiter', label: '分隔符', type: 'input', default: ',' },
        { key: 'fixedHeader', label: '固定表头', type: 'switch', default: true },
      ]
    }
  },
}
