import { describe, it, expect } from 'vitest'
import { buildFileTree, flattenTree, findNode } from '@/core/file-tree'
import type { FileEntry } from '@/adapters/types'

describe('buildFileTree', () => {
  it('builds tree from flat file list', () => {
    const files: FileEntry[] = [
      { name: 'root', path: 'root', size: 0, isDirectory: true },
      { name: 'a.txt', path: 'root/a.txt', size: 100, isDirectory: false },
      { name: 'sub', path: 'root/sub', size: 0, isDirectory: true },
      { name: 'b.log', path: 'root/sub/b.log', size: 200, isDirectory: false },
    ]
    const tree = buildFileTree(files, 'root')
    expect(tree).toHaveLength(1)
    expect(tree[0].key).toBe('root')
    expect(tree[0].children).toHaveLength(2)
  })

  it('handles empty file list', () => {
    expect(buildFileTree([], 'root')).toEqual([])
  })
})

describe('findNode', () => {
  it('finds node by key', () => {
    const files: FileEntry[] = [
      { name: 'root', path: 'root', size: 0, isDirectory: true },
      { name: 'a.txt', path: 'root/a.txt', size: 100, isDirectory: false },
    ]
    const tree = buildFileTree(files, 'root')
    const node = findNode(tree, 'root/a.txt')
    expect(node).not.toBeNull()
    expect(node!.label).toBe('a.txt')
  })

  it('returns null for missing key', () => {
    expect(findNode([], 'missing')).toBeNull()
  })
})

describe('flattenTree', () => {
  it('flattens tree to array of leaf nodes', () => {
    const files: FileEntry[] = [
      { name: 'root', path: 'root', size: 0, isDirectory: true },
      { name: 'a.txt', path: 'root/a.txt', size: 100, isDirectory: false },
      { name: 'sub', path: 'root/sub', size: 0, isDirectory: true },
      { name: 'b.log', path: 'root/sub/b.log', size: 200, isDirectory: false },
    ]
    const tree = buildFileTree(files, 'root')
    const leaves = flattenTree(tree).filter(n => n.isLeaf)
    expect(leaves).toHaveLength(2)
  })
})
