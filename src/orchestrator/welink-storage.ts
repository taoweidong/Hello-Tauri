/**
 * WeLink 存储网关（quality-hardening-2026-10 D2）—— 编排层对 SQLite 通用通道的
 * 唯一出口，welink store 经此访问仓储与迁移，不再直连 `@/infra/db`（消 S1 越层边）。
 *
 * 为什么是纯委托而不加缓存：`dbMigrateAll()`（幂等 + 失败清缓存可重试）与
 * `welink()`（进程内单例，桌面 SQLite / 浏览器内存，Q3/D5）在 infra 层已经把
 * 幂等与单例语义做完了，网关再包一层只会让测试注入（`setWelinkRepository`）
 * 失效。本模块的职责是**边界**，不是机制。
 */
import { dbMigrateAll, welink } from '@/infra/db'
import type { WelinkRepository } from '@/infra/db'

/** WeLink 表结构就绪（幂等；失败向上抛，由调用方决定降级与留痕） */
export function ensureWelinkStorage(): Promise<number[]> {
  return dbMigrateAll()
}

/** WeLink 仓储读取（浏览器模式自动落到内存实现） */
export function getWelinkRepo(): WelinkRepository {
  return welink()
}
