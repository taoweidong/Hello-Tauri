import { describe, it, expect } from 'vitest'
import { parseCsv } from '@/plugins/parsers/csv-parser'
import type { CsvData } from '@/types'

describe('parseCsv', () => {
  it('解析表头与数据行', () => {
    const result = parseCsv('name,age\nAlice,30\nBob,25')
    expect(result.type).toBe('csv')
    const data = result.data as CsvData
    expect(data.headers).toEqual(['name', 'age'])
    expect(data.rows).toEqual([['Alice', '30'], ['Bob', '25']])
    expect(result.lineCount).toBe(3)
  })

  it('支持自定义分隔符', () => {
    const result = parseCsv('name\tage\nAlice\t30', '\t')
    const data = result.data as CsvData
    expect(data.headers).toEqual(['name', 'age'])
  })

  it('过滤空行', () => {
    const result = parseCsv('a,b\n\n1,2')
    const data = result.data as CsvData
    expect(data.rows).toEqual([['1', '2']])
  })

  it('单行（仅表头）', () => {
    const result = parseCsv('a,b,c')
    const data = result.data as CsvData
    expect(data.headers).toEqual(['a', 'b', 'c'])
    expect(data.rows).toEqual([])
  })

  it('空文本返回空结构', () => {
    const result = parseCsv('')
    const data = result.data as CsvData
    expect(data.headers).toEqual([])
    expect(data.rows).toEqual([])
  })
})
