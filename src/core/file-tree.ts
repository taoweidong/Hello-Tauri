import type { FileTreeNode } from '@/adapters/types'
import type { FileEntry } from '@/adapters/types'

export function buildFileTree(files: FileEntry[], rootPath: string): FileTreeNode[] {
  if (files.length === 0) return []

  const nodeMap = new Map<string, FileTreeNode>()
  const placed = new Set<string>()

  for (const file of files) {
    const node: FileTreeNode = {
      key: file.path,
      label: file.name,
      isLeaf: !file.isDirectory,
      path: file.path,
      size: file.size,
      children: file.isDirectory ? [] : undefined,
    }
    nodeMap.set(file.path, node)
  }

  const rootNodes: FileTreeNode[] = []

  for (const file of files) {
    const node = nodeMap.get(file.path)!
    if (placed.has(file.path)) continue

    const parentPath = file.path === rootPath
      ? ''
      : file.path.substring(0, file.path.lastIndexOf('/'))

    if (parentPath && nodeMap.has(parentPath)) {
      nodeMap.get(parentPath)!.children!.push(node)
    } else {
      rootNodes.push(node)
    }
    placed.add(file.path)
  }

  return rootNodes
}

export function findNode(nodes: FileTreeNode[], key: string): FileTreeNode | null {
  for (const node of nodes) {
    if (node.key === key) return node
    if (node.children) {
      const found = findNode(node.children, key)
      if (found) return found
    }
  }
  return null
}

export function flattenTree(nodes: FileTreeNode[]): FileTreeNode[] {
  const result: FileTreeNode[] = []
  function walk(nodeList: FileTreeNode[]) {
    for (const node of nodeList) {
      result.push(node)
      if (node.children) walk(node.children)
    }
  }
  walk(nodes)
  return result
}
