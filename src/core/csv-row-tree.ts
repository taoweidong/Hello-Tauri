/**
 * CSV 行树构建模块
 * 将 CSV 单行数据按列派生为合并的树结构（JSON / 路径 / 兜底字符串）
 */

/** 行树节点 */
export interface RowTreeNode {
  /** 节点键名（列名或路径段） */
  key: string
  /** 节点显示值（仅叶子节点有） */
  value?: unknown
  /** 子节点 */
  children?: RowTreeNode[]
  /** 是否为叶子节点 */
  isLeaf: boolean
  /** 来源列名（用于根级节点标识原始列） */
  sourceColumn?: string
  /** 节点值类型（叶子节点：'string'|'number'|'boolean'|'null'|'object'|'array'） */
  valueType?: 'string' | 'number' | 'boolean' | 'null' | 'object' | 'array'
}

/** 合法标识符正则：首字符 [A-Za-z_]，其余 [A-Za-z0-9_\-] */
const IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_\-]*$/

/** 判断字符串是否为合法标识符 */
function isValidIdentifier(s: string): boolean {
  return IDENTIFIER_RE.test(s)
}

/**
 * 安全尝试将单元格解析为 JSON 对象或数组
 * 仅接受 {...} 或 [...] 形式；原始类型（number/string 等）返回 null
 */
export function tryParseJsonCell(value: string): unknown | null {
  const trimmed = value.trim()
  // 仅接受对象或数组形式
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
    return null
  }
  try {
    const parsed = JSON.parse(trimmed)
    // 仅保留非 null 的对象或数组（typeof null === 'object'，需单独排除）
    if (parsed === null || typeof parsed !== 'object') {
      return null
    }
    return parsed
  } catch {
    return null
  }
}

/**
 * 识别路径型单元格，返回拆分后的路径段
 * 优先级：先 / 再 \ 最后 .
 * 含 . 时每段必须为合法标识符（避免误判小数如 3.14）
 * 至少 2 段才返回，否则返回 null
 */
export function tryParsePathCell(value: string): string[] | null {
  if (value === '') return null

  // 优先级：先检查 /，再 \，最后 .
  if (value.includes('/')) {
    const segments = value.split('/')
    return segments.length >= 2 ? segments : null
  }
  if (value.includes('\\')) {
    const segments = value.split('\\')
    return segments.length >= 2 ? segments : null
  }
  if (value.includes('.')) {
    const segments = value.split('.')
    // 每段必须为合法标识符，避免误判小数（如 3.14 → ['3','14']，'3' 非合法首字符）
    if (segments.length >= 2 && segments.every(isValidIdentifier)) {
      return segments
    }
    return null
  }
  return null
}

/**
 * 递归将 JSON 解析结果转为 RowTreeNode
 * 对象 → children 为 Object.entries 子节点
 * 数组 → children 为带索引键（[0]、[1]...）的子节点
 * 原始类型 → 叶子节点
 * null → 叶子节点，valueType 'null'
 */
export function buildJsonBranch(header: string, parsed: unknown): RowTreeNode {
  const buildNode = (key: string, value: unknown): RowTreeNode => {
    if (value === null) {
      return { key, isLeaf: true, value: null, valueType: 'null' }
    }
    if (Array.isArray(value)) {
      return {
        key,
        isLeaf: false,
        valueType: 'array',
        children: value.map((v, i) => buildNode(`[${i}]`, v)),
      }
    }
    if (typeof value === 'object') {
      return {
        key,
        isLeaf: false,
        valueType: 'object',
        children: Object.entries(value as Record<string, unknown>).map(
          ([k, v]) => buildNode(k, v),
        ),
      }
    }
    // 原始类型：string / number / boolean
    return {
      key,
      isLeaf: true,
      value,
      valueType: typeof value as 'string' | 'number' | 'boolean',
    }
  }

  // 根分支节点：header 作为 key，附加 sourceColumn 标识原始列
  const node = buildNode(header, parsed)
  node.sourceColumn = header
  return node
}

/**
 * 将路径段构建为嵌套对象树
 * 末段为叶子节点（isLeaf: true, valueType: 'string'），中间段为非叶子节点
 * 例：['a','b','c'] → a > b > c 的嵌套树
 */
export function buildPathBranch(header: string, segments: string[]): RowTreeNode {
  // 从末段向前构建嵌套结构
  let inner: RowTreeNode = {
    key: segments[segments.length - 1],
    isLeaf: true,
    valueType: 'string',
  }
  for (let i = segments.length - 2; i >= 0; i--) {
    inner = {
      key: segments[i],
      isLeaf: false,
      children: [inner],
    }
  }
  // 根分支节点
  return {
    key: header,
    isLeaf: false,
    sourceColumn: header,
    children: [inner],
  }
}

/**
 * 将 CSV 一行数据按列派生为合并的行树
 * 派生顺序：JSON 列 → 路径型列 → 兜底字符串叶子
 * 空行返回空 root；headers 与 row 长度不一致时按 Math.min 处理
 */
export function extractRowTree(headers: string[], row: string[]): RowTreeNode {
  const root: RowTreeNode = { key: 'root', isLeaf: false, children: [] }
  // 空行直接返回空 root
  if (row.length === 0) return root

  const len = Math.min(headers.length, row.length)
  for (let i = 0; i < len; i++) {
    const header = headers[i]
    const cell = row[i]
    let branch: RowTreeNode

    const parsed = tryParseJsonCell(cell)
    if (parsed !== null) {
      // JSON 列：对象或数组
      branch = buildJsonBranch(header, parsed)
    } else {
      const segments = tryParsePathCell(cell)
      if (segments !== null) {
        // 路径型列
        branch = buildPathBranch(header, segments)
      } else {
        // 兜底：字符串叶子
        branch = {
          key: header,
          value: cell,
          isLeaf: true,
          sourceColumn: header,
          valueType: 'string',
        }
      }
    }
    root.children!.push(branch)
  }
  return root
}
