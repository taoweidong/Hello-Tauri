/**
 * 知识库端口装配（knowledge-sedimentation K-G）。
 *
 * 消费方式：
 *  * 编排层（harvester / pipeline）：直接 import 本工厂；
 *  * UI 层：经 stores 装配（UI 禁触 @/infra/**，ESLint D4 闸门）。
 *
 * 端口无连接配置（与 rag 的热更新缓存键不同），进程内单例即可。
 */
import { platform } from '@/api'
import { createFsKnowledgePort } from './knowledge-fs'
import { createMockKnowledgePort } from './mock'
import type { KnowledgePort } from './port'

export type { KnowledgeDoc, KnowledgeDocSource, KnowledgeErrorKind, KnowledgePort } from './port'
export { KNOWLEDGE_INDEX_FILE, KnowledgeError, toKnowledgeFileName } from './port'
/** 测试用：内存实现构造、重置与文件预置（内存态单例） */
export { createMockKnowledgePort, resetMockKnowledge, seedMockKnowledgeFile } from './mock'

let instance: KnowledgePort | null = null

/** 知识库端口单例（桌面 = 数据根文件通道；浏览器 = 内存实现，Q3/D5） */
export function knowledgePort(): KnowledgePort {
  if (!instance) {
    instance = platform === 'tauri' ? createFsKnowledgePort() : createMockKnowledgePort()
  }
  return instance
}

/** 测试用：替换端口实现（注入假件） */
export function setKnowledgePort(port: KnowledgePort | null) {
  instance = port
}
