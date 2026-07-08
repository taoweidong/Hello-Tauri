import type { FileTreeNode, FileEntry } from '@/types'

/** 文件树构建器，将扁平文件列表转换为树形结构 */
export class FileTreeBuilder {
  private nodeMap = new Map<string, FileTreeNode>()
  private placed = new Set<string>()

  /**
   * 将扁平文件条目列表构建为树形节点数组
   * @param files - 文件条目列表
   * @param rootPath - 根路径（用于判断顶层节点）
   * @returns 顶层树节点数组
   */
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
        const parent = this.nodeMap.get(parentPath)!
        if (parent.children) {
          parent.children.push(node)
        } else {
          // 父节点意外地没有 children 数组，作为根节点处理
          rootNodes.push(node)
        }
      } else {
        rootNodes.push(node)
      }
      this.placed.add(file.path)
    }

    return rootNodes
  }

  /**
   * 在树中递归查找指定 key 的节点
   * @param nodes - 搜索起始的节点列表
   * @param key - 目标节点的 key
   * @returns 找到的节点或 null
   */
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

  /**
   * 将树形结构扁平化为一维数组
   * @param nodes - 顶层节点列表
   * @returns 扁平化后的所有节点
   */
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
