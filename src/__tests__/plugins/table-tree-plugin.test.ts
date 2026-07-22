import { describe, it, expect } from 'vitest'
import { tableTreePlugin } from '@/plugins/parser/table-tree-plugin'

describe('tableTreePlugin', () => {
  describe('canParse', () => {
    it('识别 _table_tree.csv 后缀文件', () => {
      expect(tableTreePlugin.canParse({ name: 'sample_table_tree.csv', size: 100, path: '/sample_table_tree.csv', isDirectory: false })).toBe(true)
      expect(tableTreePlugin.canParse({ name: 'data_TABLE_TREE.CSV', size: 100, path: '/data_TABLE_TREE.CSV', isDirectory: false })).toBe(true)
    })

    it('不识别普通 csv 文件', () => {
      expect(tableTreePlugin.canParse({ name: 'sample.csv', size: 100, path: '/sample.csv', isDirectory: false })).toBe(false)
      expect(tableTreePlugin.canParse({ name: 'table_tree.csv', size: 100, path: '/table_tree.csv', isDirectory: false })).toBe(false)
    })

    it('不识别其他类型文件', () => {
      expect(tableTreePlugin.canParse({ name: 'test.txt', size: 100, path: '/test.txt', isDirectory: false })).toBe(false)
      expect(tableTreePlugin.canParse({ name: 'test.json', size: 100, path: '/test.json', isDirectory: false })).toBe(false)
    })
  })

  describe('parse', () => {
    it('解析 CSV 数据', async () => {
      const csvContent = 'name,age\nAlice,30\nBob,25'
      const data = new TextEncoder().encode(csvContent)
      const result = await tableTreePlugin.parse(data)

      expect(result.type).toBe('csv')
      expect((result.data as any).headers).toEqual(['name', 'age'])
      expect((result.data as any).rows).toEqual([['Alice', '30'], ['Bob', '25']])
    })

    it('支持自定义分隔符', async () => {
      const csvContent = 'name;age\nAlice;30'
      const data = new TextEncoder().encode(csvContent)
      const result = await tableTreePlugin.parse(data, { delimiter: ';' })

      expect((result.data as any).headers).toEqual(['name', 'age'])
      expect((result.data as any).rows).toEqual([['Alice', '30']])
    })

    it('支持自定义编码', async () => {
      const csvContent = 'name,age\nAlice,30'
      const data = new TextEncoder().encode(csvContent)
      const result = await tableTreePlugin.parse(data, { encoding: 'utf-8' })

      expect(result.type).toBe('csv')
    })
  })

  describe('getComponent', () => {
    it('返回 TableTreeRenderer 组件', () => {
      const component = tableTreePlugin.getComponent()
      expect(component).toBeDefined()
    })
  })

  it('插件名称为 table-tree', () => {
    expect(tableTreePlugin.name).toBe('table-tree')
  })

  it('supportedExtensions 为空数组（通过文件名规则匹配）', () => {
    expect(tableTreePlugin.supportedExtensions).toEqual([])
  })
})
