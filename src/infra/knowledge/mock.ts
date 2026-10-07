import { createKnowledgeCore, type KnowledgePort } from './port'

/**
 * 知识库端口的内存实现（测试替身与浏览器调试数据源）。
 *
 * 与 fs 适配器共享同一核心语义（createKnowledgeCore），只把 IO 换成内存 Map ——
 * 「文件」与「清单」的一致性语义与桌面实现完全一致，契约测试可对两个适配器跑
 * 同一组断言。
 */

interface MemoryFile {
  content: string
}

export interface MockKnowledgeState {
  files: Map<string, MemoryFile>
}

export function createMockKnowledgeState(): MockKnowledgeState {
  return { files: new Map() }
}

/** 全局单例状态（测试用 resetMockKnowledge 重置） */
let state: MockKnowledgeState = createMockKnowledgeState()

/** 测试与视图重置用 */
export function resetMockKnowledge() {
  state = createMockKnowledgeState()
}

/** 预置一个文件（测试夹具：模拟用户手动放入 knowledge/ 的文件） */
export function seedMockKnowledgeFile(relative: string, content: string) {
  state.files.set(relative, { content })
}

export function createMockKnowledgePort(): KnowledgePort {
  return createKnowledgeCore({
    async readFile(relative: string) {
      return state.files.get(relative)?.content ?? null
    },
    async writeFile(relative: string, content: string) {
      state.files.set(relative, { content })
    },
  })
}

/** 测试用：读取任意相对路径文件内容（含清单 JSON） */
export function peekMockKnowledgeFile(relative: string): string | null {
  return state.files.get(relative)?.content ?? null
}
