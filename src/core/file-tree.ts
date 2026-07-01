import type { FileTreeNode, FileEntry } from '@/types'

export class FileTreeBuilder {
  private nodeMap = new Map<string, FileTreeNode>()
  private placed = new Set<string>()

  build(files: FileEntry[], rootPath: string): FileTreeNode[] {
    if (files.length === 0) return []

    this.nodeMap.clear()
    this.placed.clear()

    for (const file of files) {
      const node: FileTreeNode = {
        key: file.path,
        label: file.name,
        isLeaf: !file.isDirectory,
        path: file.path,
        size: file.size,
        children: file.isDirectory ? [] : undefined,
      }
      this.nodeMap.set(file.path, node)
    }

    const rootNodes: FileTreeNode[] = []

    for (const file of files) {
      const node = this.nodeMap.get(file.path)!
      if (this.placed.has(file.path)) continue

      const parentPath = file.path === rootPath
        ? ''
        : file.path.substring(0, file.path.lastIndexOf('/'))

      if (parentPath && this.nodeMap.has(parentPath)) {
        this.nodeMap.get(parentPath)!.children!.push(node)
      } else {
        rootNodes.push(node)
      }
      this.placed.add(file.path)
    }

    return rootNodes
  }

  static findNode(nodes: FileTreeNode[], key: string): FileTreeNode | null {
    for (const node of nodes) {
      if (node.key === key) return node
      if (node.children) {
        const found = this.findNode(node.children, key)
        if (found) return found
      }
    }
    return null
  }

  static flattenTree(nodes: FileTreeNode[]): FileTreeNode[] {
    const result: FileTreeNode[] = []
    const walk = (nodeList: FileTreeNode[]) => {
      for (const node of nodeList) {
        result.push(node)
        if (node.children) walk(node.children)
      }
    }
    walk(nodes)
    return result
  }
}
