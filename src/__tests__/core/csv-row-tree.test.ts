import { describe, it, expect } from 'vitest'
import {
  extractRowTree,
  tryParseJsonCell,
  tryParsePathCell,
  buildJsonBranch,
  buildPathBranch,
} from '@/core/csv-row-tree'

describe('tryParseJsonCell', () => {
  it('解析对象 JSON', () => {
    expect(tryParseJsonCell('{"host":"localhost","port":8080}')).toEqual({
      host: 'localhost',
      port: 8080,
    })
  })

  it('解析数组 JSON', () => {
    expect(tryParseJsonCell('["a","b","c"]')).toEqual(['a', 'b', 'c'])
  })

  it('数字字面量返回 null', () => {
    expect(tryParseJsonCell('123')).toBeNull()
  })

  it('字符串字面量返回 null', () => {
    expect(tryParseJsonCell('"abc"')).toBeNull()
  })

  it('null 字面量返回 null', () => {
    expect(tryParseJsonCell('null')).toBeNull()
  })

  it('布尔字面量返回 null', () => {
    expect(tryParseJsonCell('true')).toBeNull()
  })

  it('非法 JSON 返回 null', () => {
    expect(tryParseJsonCell('{a:1}')).toBeNull()
  })

  it('空字符串返回 null', () => {
    expect(tryParseJsonCell('')).toBeNull()
  })

  it('去除首尾空白', () => {
    expect(tryParseJsonCell('  {"a":1}  ')).toEqual({ a: 1 })
  })

  it('空对象返回空对象', () => {
    expect(tryParseJsonCell('{}')).toEqual({})
  })

  it('空数组返回空数组', () => {
    expect(tryParseJsonCell('[]')).toEqual([])
  })
})

describe('tryParsePathCell', () => {
  it('斜杠路径', () => {
    expect(tryParsePathCell('src/components/Foo.vue')).toEqual([
      'src',
      'components',
      'Foo.vue',
    ])
  })

  it('反斜杠路径', () => {
    expect(tryParsePathCell('a\\b\\c')).toEqual(['a', 'b', 'c'])
  })

  it('点号标识符路径', () => {
    expect(tryParsePathCell('app.server.url')).toEqual(['app', 'server', 'url'])
  })

  it('点号路径支持含连字符的段', () => {
    expect(tryParsePathCell('app.base-url')).toEqual(['app', 'base-url'])
  })

  it('小数不误判', () => {
    expect(tryParsePathCell('3.14')).toBeNull()
  })

  it('版本号不误判', () => {
    expect(tryParsePathCell('1.2.3')).toBeNull()
  })

  it('空字符串返回 null', () => {
    expect(tryParsePathCell('')).toBeNull()
  })

  it('单段返回 null', () => {
    expect(tryParsePathCell('abc')).toBeNull()
  })

  it('优先级：/ 高于 .', () => {
    // 含 / 时按 / 拆分，不再按 . 拆分
    expect(tryParsePathCell('src/foo.bar')).toEqual(['src', 'foo.bar'])
  })

  it('优先级：\\ 高于 .', () => {
    expect(tryParsePathCell('a\\b.c')).toEqual(['a', 'b.c'])
  })

  it('点号路径某段非合法标识符返回 null', () => {
    expect(tryParsePathCell('app.3config')).toBeNull()
  })
})

describe('buildJsonBranch', () => {
  it('对象转为子节点', () => {
    const node = buildJsonBranch('config', { host: 'localhost', port: 8080 })
    expect(node.key).toBe('config')
    expect(node.sourceColumn).toBe('config')
    expect(node.isLeaf).toBe(false)
    expect(node.children).toHaveLength(2)
    expect(node.children![0].key).toBe('host')
    expect(node.children![0].value).toBe('localhost')
    expect(node.children![0].valueType).toBe('string')
    expect(node.children![0].isLeaf).toBe(true)
    expect(node.children![1].key).toBe('port')
    expect(node.children![1].value).toBe(8080)
    expect(node.children![1].valueType).toBe('number')
    expect(node.children![1].isLeaf).toBe(true)
  })

  it('数组转为索引子节点', () => {
    const node = buildJsonBranch('tags', ['a', 'b', 'c'])
    expect(node.key).toBe('tags')
    expect(node.sourceColumn).toBe('tags')
    expect(node.isLeaf).toBe(false)
    expect(node.children).toHaveLength(3)
    expect(node.children!.map((c) => c.key)).toEqual(['[0]', '[1]', '[2]'])
    expect(node.children![0].value).toBe('a')
    expect(node.children![0].valueType).toBe('string')
    expect(node.children![2].value).toBe('c')
  })

  it('嵌套对象递归构建', () => {
    const node = buildJsonBranch('cfg', { db: { host: 'h' } })
    const db = node.children![0]
    expect(db.key).toBe('db')
    expect(db.isLeaf).toBe(false)
    const host = db.children![0]
    expect(host.key).toBe('host')
    expect(host.value).toBe('h')
    expect(host.isLeaf).toBe(true)
  })

  it('null 值叶子节点', () => {
    const node = buildJsonBranch('cfg', { x: null })
    expect(node.children![0].value).toBeNull()
    expect(node.children![0].valueType).toBe('null')
    expect(node.children![0].isLeaf).toBe(true)
  })

  it('布尔值叶子节点', () => {
    const node = buildJsonBranch('cfg', { enabled: true })
    expect(node.children![0].value).toBe(true)
    expect(node.children![0].valueType).toBe('boolean')
  })

  it('嵌套数组', () => {
    const node = buildJsonBranch('cfg', { items: [1, 2] })
    const items = node.children![0]
    expect(items.key).toBe('items')
    expect(items.isLeaf).toBe(false)
    expect(items.children!.map((c) => c.key)).toEqual(['[0]', '[1]'])
    expect(items.children![0].value).toBe(1)
    expect(items.children![0].valueType).toBe('number')
  })
})

describe('buildPathBranch', () => {
  it('构建嵌套路径树（三段）', () => {
    const node = buildPathBranch('path', ['a', 'b', 'c'])
    expect(node).toEqual({
      key: 'path',
      isLeaf: false,
      sourceColumn: 'path',
      children: [
        {
          key: 'a',
          isLeaf: false,
          children: [
            {
              key: 'b',
              isLeaf: false,
              children: [{ key: 'c', isLeaf: true, valueType: 'string' }],
            },
          ],
        },
      ],
    })
  })

  it('两段路径', () => {
    const node = buildPathBranch('p', ['x', 'y'])
    expect(node.children![0].key).toBe('x')
    expect(node.children![0].isLeaf).toBe(false)
    expect(node.children![0].children![0].key).toBe('y')
    expect(node.children![0].children![0].isLeaf).toBe(true)
    expect(node.children![0].children![0].valueType).toBe('string')
  })
})

describe('extractRowTree', () => {
  it('空行返回空 root', () => {
    const tree = extractRowTree([], [])
    expect(tree.key).toBe('root')
    expect(tree.isLeaf).toBe(false)
    expect(tree.children).toEqual([])
  })

  it('row 为空但 headers 非空时仍返回空 root', () => {
    const tree = extractRowTree(['a', 'b'], [])
    expect(tree.children).toEqual([])
  })

  it('纯普通字段（兜底）', () => {
    const tree = extractRowTree(['name', 'age'], ['Alice', '30'])
    expect(tree.key).toBe('root')
    expect(tree.children).toHaveLength(2)
    expect(tree.children![0]).toEqual({
      key: 'name',
      value: 'Alice',
      isLeaf: true,
      sourceColumn: 'name',
      valueType: 'string',
    })
    expect(tree.children![1]).toEqual({
      key: 'age',
      value: '30',
      isLeaf: true,
      sourceColumn: 'age',
      valueType: 'string',
    })
  })

  it('JSON 列：对象', () => {
    const tree = extractRowTree(
      ['config'],
      ['{"host":"localhost","port":8080}'],
    )
    expect(tree.children).toHaveLength(1)
    const branch = tree.children![0]
    expect(branch.key).toBe('config')
    expect(branch.isLeaf).toBe(false)
    expect(branch.sourceColumn).toBe('config')
    expect(branch.children).toHaveLength(2)
    expect(branch.children!.map((c) => c.key)).toEqual(['host', 'port'])
    const hostLeaf = branch.children!.find((c) => c.key === 'host')!
    expect(hostLeaf.value).toBe('localhost')
    expect(hostLeaf.valueType).toBe('string')
    expect(hostLeaf.isLeaf).toBe(true)
    const portLeaf = branch.children!.find((c) => c.key === 'port')!
    expect(portLeaf.value).toBe(8080)
    expect(portLeaf.valueType).toBe('number')
    expect(portLeaf.isLeaf).toBe(true)
  })

  it('JSON 列：数组', () => {
    const tree = extractRowTree(['tags'], ['["a","b","c"]'])
    const branch = tree.children![0]
    expect(branch.key).toBe('tags')
    expect(branch.sourceColumn).toBe('tags')
    expect(branch.isLeaf).toBe(false)
    expect(branch.children).toHaveLength(3)
    expect(branch.children!.map((c) => c.key)).toEqual(['[0]', '[1]', '[2]'])
    expect(branch.children![0].value).toBe('a')
    expect(branch.children![2].value).toBe('c')
  })

  it('路径列（/ 分隔）', () => {
    const tree = extractRowTree(['path'], ['src/components/Foo.vue'])
    const branch = tree.children![0]
    expect(branch.key).toBe('path')
    expect(branch.sourceColumn).toBe('path')
    expect(branch.isLeaf).toBe(false)
    // src > components > Foo.vue
    const src = branch.children![0]
    expect(src.key).toBe('src')
    expect(src.isLeaf).toBe(false)
    const comp = src.children![0]
    expect(comp.key).toBe('components')
    expect(comp.isLeaf).toBe(false)
    const foo = comp.children![0]
    expect(foo.key).toBe('Foo.vue')
    expect(foo.isLeaf).toBe(true)
    expect(foo.valueType).toBe('string')
  })

  it('路径列（. 分隔）', () => {
    const tree = extractRowTree(['config'], ['app.server.url'])
    const branch = tree.children![0]
    expect(branch.children![0].key).toBe('app')
    expect(branch.children![0].isLeaf).toBe(false)
    expect(branch.children![0].children![0].key).toBe('server')
    expect(branch.children![0].children![0].children![0].key).toBe('url')
    expect(branch.children![0].children![0].children![0].isLeaf).toBe(true)
    expect(branch.children![0].children![0].children![0].valueType).toBe(
      'string',
    )
  })

  it('小数不误判为路径', () => {
    const tree = extractRowTree(['price'], ['3.14'])
    expect(tree.children).toHaveLength(1)
    expect(tree.children![0].isLeaf).toBe(true)
    expect(tree.children![0].value).toBe('3.14')
    expect(tree.children![0].valueType).toBe('string')
    expect(tree.children![0].sourceColumn).toBe('price')
  })

  it('混合多种类型合并到 root.children', () => {
    const tree = extractRowTree(
      ['name', 'config', 'path', 'tags', 'price'],
      [
        'Alice',
        '{"host":"localhost"}',
        'src/main.ts',
        '["x","y"]',
        '3.14',
      ],
    )
    expect(tree.children).toHaveLength(5)

    // name 兜底叶子
    expect(tree.children![0].key).toBe('name')
    expect(tree.children![0].isLeaf).toBe(true)
    expect(tree.children![0].value).toBe('Alice')

    // config JSON 对象分支
    expect(tree.children![1].key).toBe('config')
    expect(tree.children![1].isLeaf).toBe(false)
    expect(tree.children![1].children!.map((c) => c.key)).toEqual(['host'])

    // path 路径分支：src > main.ts
    expect(tree.children![2].key).toBe('path')
    expect(tree.children![2].isLeaf).toBe(false)
    expect(tree.children![2].children![0].key).toBe('src')
    expect(tree.children![2].children![0].children![0].key).toBe('main.ts')
    expect(tree.children![2].children![0].children![0].isLeaf).toBe(true)

    // tags JSON 数组分支
    expect(tree.children![3].key).toBe('tags')
    expect(tree.children![3].children!.map((c) => c.key)).toEqual([
      '[0]',
      '[1]',
    ])

    // price 兜底（小数不误判）
    expect(tree.children![4].key).toBe('price')
    expect(tree.children![4].isLeaf).toBe(true)
    expect(tree.children![4].value).toBe('3.14')
  })

  it('headers 与 row 长度不一致按 min 处理', () => {
    // headers 多于 row
    const tree1 = extractRowTree(['a', 'b', 'c'], ['1'])
    expect(tree1.children).toHaveLength(1)
    expect(tree1.children![0].key).toBe('a')
    expect(tree1.children![0].value).toBe('1')

    // row 多于 headers
    const tree2 = extractRowTree(['a'], ['1', '2', '3'])
    expect(tree2.children).toHaveLength(1)
    expect(tree2.children![0].key).toBe('a')
    expect(tree2.children![0].value).toBe('1')
  })

  it('根节点结构正确', () => {
    const tree = extractRowTree(['a'], ['1'])
    expect(tree.key).toBe('root')
    expect(tree.isLeaf).toBe(false)
    expect(Array.isArray(tree.children)).toBe(true)
  })
})
