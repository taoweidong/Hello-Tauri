import { describe, it, expect } from 'vitest'
import { FileTreeBuilder } from '@/core/file-tree'
import type { FileEntry } from '@/types'

describe('FileTreeBuilder', () => {
  const builder = new FileTreeBuilder()

  it('builds tree from flat file list', () => {
    const files: FileEntry[] = [
      { name: 'root', path: 'root', size: 0, isDirectory: true },
      { name: 'a.txt', path: 'root/a.txt', size: 100, isDirectory: false },
      { name: 'sub', path: 'root/sub', size: 0, isDirectory: true },
      { name: 'b.log', path: 'root/sub/b.log', size: 200, isDirectory: false },
    ]
    const tree = builder.build(files, 'root')
    expect(tree).toHaveLength(1)
    expect(tree[0].key).toBe('root')
    expect(tree[0].children).toHaveLength(2)
  })

  it('handles empty file list', () => {
    expect(builder.build([], 'root')).toEqual([])
  })

  it('finds node by key', () => {
    const files: FileEntry[] = [
      { name: 'root', path: 'root', size: 0, isDirectory: true },
      { name: 'a.txt', path: 'root/a.txt', size: 100, isDirectory: false },
    ]
    const tree = builder.build(files, 'root')
    const node = FileTreeBuilder.findNode(tree, 'root/a.txt')
    expect(node).not.toBeNull()
    expect(node!.label).toBe('a.txt')
  })

  it('returns null for missing key', () => {
    expect(FileTreeBuilder.findNode([], 'missing')).toBeNull()
  })

  it('flattens tree to array of leaf nodes', () => {
    const files: FileEntry[] = [
      { name: 'root', path: 'root', size: 0, isDirectory: true },
      { name: 'a.txt', path: 'root/a.txt', size: 100, isDirectory: false },
      { name: 'sub', path: 'root/sub', size: 0, isDirectory: true },
      { name: 'b.log', path: 'root/sub/b.log', size: 200, isDirectory: false },
    ]
    const tree = builder.build(files, 'root')
    const leaves = FileTreeBuilder.flattenTree(tree).filter(n => n.isLeaf)
    expect(leaves).toHaveLength(2)
  })
})
