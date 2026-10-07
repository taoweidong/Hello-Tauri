/**
 * 知识库端口的文件系统适配器（桌面模式）。
 *
 * 只做一件事：把 Bridge 的数据根内安全文件通道（fsRead/fsWrite，拒绝越界路径、
 * 写自动建父目录）适配成核心的 IO 接口 —— 全部清单语义都在 port.ts 的共享核心里，
 * 本文件零业务逻辑。
 */
import { bridge } from '@/api'
import { createKnowledgeCore, type KnowledgePort } from './port'

export function createFsKnowledgePort(): KnowledgePort {
  return createKnowledgeCore({
    readFile(relative: string) {
      return bridge.fsRead(relative)
    },
    async writeFile(relative: string, content: string) {
      await bridge.fsWrite(relative, content)
    },
  })
}
