import { describe, it, expect } from 'vitest'
import { csvPlugin } from '@/plugins/parser/csv-plugin'
import type { CsvData } from '@/types'

describe('csvPlugin', () => {
  it('canParse returns true for .csv files', () => {
    expect(csvPlugin.canParse({ name: 'data.csv', path: '/', size: 0, isDirectory: false })).toBe(true)
    expect(csvPlugin.canParse({ name: 'data.tsv', path: '/', size: 0, isDirectory: false })).toBe(true)
    expect(csvPlugin.canParse({ name: 'data.txt', path: '/', size: 0, isDirectory: false })).toBe(false)
  })

  it('parse returns headers and rows', async () => {
    const data = new TextEncoder().encode('name,age\nAlice,30\nBob,25')
    const result = await csvPlugin.parse(data)
    expect(result.type).toBe('csv')
    const csvData = result.data as CsvData
    expect(csvData.headers).toEqual(['name', 'age'])
    expect(csvData.rows).toEqual([['Alice', '30'], ['Bob', '25']])
    expect(result.lineCount).toBe(3)
  })

  it('parse respects custom delimiter', async () => {
    const data = new TextEncoder().encode('name\tage\nAlice\t30')
    const result = await csvPlugin.parse(data, { delimiter: '\t' })
    const csvData = result.data as CsvData
    expect(csvData.headers).toEqual(['name', 'age'])
  })

  it('parse handles empty file', async () => {
    const data = new Uint8Array(0)
    const result = await csvPlugin.parse(data)
    const csvData = result.data as CsvData
    expect(csvData.headers).toEqual([])
    expect(csvData.rows).toEqual([])
  })

  it('getComponent 返回 CsvRenderer 组件', () => {
    const component = csvPlugin.getComponent()
    expect(component).toBeDefined()
  })

  it('getConfigSchema 返回分隔符和固定表头配置', () => {
    const schema = csvPlugin.getConfigSchema!()
    expect(schema.fields).toHaveLength(2)
    expect(schema.fields[0].key).toBe('delimiter')
    expect(schema.fields[0].default).toBe(',')
    expect(schema.fields[1].key).toBe('fixedHeader')
    expect(schema.fields[1].default).toBe(true)
  })

  it('parse 支持自定义编码', async () => {
    const data = new TextEncoder().encode('a,b\n1,2')
    const result = await csvPlugin.parse(data, { encoding: 'utf-8' })
    expect(result.type).toBe('csv')
  })
})
