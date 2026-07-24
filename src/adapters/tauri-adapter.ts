import type { IPlatformAdapter } from './types'
import type { FileEntry } from '@/types'

/** 懒加载 Tauri 插件函数（避免非 Tauri 环境报错） */
let fsModule: typeof import('@tauri-apps/plugin-fs') | null = null
let pathModule: typeof import('@tauri-apps/api/path') | null = null

/** 获取 fs 插件模块单例 */
async function getFs() {
  if (!fsModule) {
    fsModule = await import('@tauri-apps/plugin-fs')
  }
  return fsModule
}

/** 获取 path 模块单例 */
async function getPath() {
  if (!pathModule) {
    pathModule = await import('@tauri-apps/api/path')
  }
  return pathModule
}

/** 缓存应用数据目录（避免重复 IPC） */
let appDataDirCache: string | null = null

/** 获取应用数据目录 */
async function getAppDataDir(): Promise<string> {
  if (!appDataDirCache) {
    const path = await getPath()
    appDataDirCache = await path.appDataDir()
  }
  return appDataDirCache
}

/**
 * 路径安全校验：
 * 1. 拒绝包含 '..' 的路径（防止路径穿越）
 * 2. 校验解析后的路径必须在 appDataDir 内
 */
async function validatePath(inputPath: string): Promise<string> {
  if (inputPath.includes('..')) {
    throw new Error(`路径包含 '..' 组件，不允许路径穿越: ${inputPath}`)
  }
  const base = await getAppDataDir()
  // 统一分隔符后检查前缀
  const normalized = inputPath.replace(/\\/g, '/')
  const normalizedBase = base.replace(/\\/g, '/')
  if (!normalized.startsWith(normalizedBase)) {
    throw new Error(`路径 '${inputPath}' 不在允许目录 '${base}' 内`)
  }
  return inputPath
}

/** 目录遍历最大深度限制 */
const MAX_WALK_DEPTH = 20

/**
 * Tauri 平台适配器实现
 * 通过 Tauri 官方插件（plugin-fs / api-path）实现文件操作，不包含自定义 Rust 命令
 */
export class TauriAdapter implements IPlatformAdapter {
  /** 通过 plugin-fs 读取文件 */
  async readFile(path: string): Promise<Uint8Array> {
    await validatePath(path)
    const fs = await getFs()
    return fs.readFile(path)
  }

  /** 通过 plugin-fs 写入文件 */
  async writeFile(path: string, data: Uint8Array): Promise<void> {
    await validatePath(path)
    const fs = await getFs()
    await fs.writeFile(path, data)
  }

  /** 通过 plugin-fs 递归列出目录文件（带深度限制） */
  async listFiles(dir: string): Promise<FileEntry[]> {
    await validatePath(dir)
    const fs = await getFs()
    const results: FileEntry[] = []
    await this.walkDir(fs, dir, results, 0)
    return results
  }

  /** 递归遍历目录（内部方法，带深度限制防止栈溢出） */
  private async walkDir(
    fs: typeof import('@tauri-apps/plugin-fs'),
    dir: string,
    results: FileEntry[],
    depth: number
  ): Promise<void> {
    if (depth > MAX_WALK_DEPTH) return
    const entries = await fs.readDir(dir)
    for (const entry of entries) {
      const fullPath = `${dir}/${entry.name}`
      const isDir = entry.isDirectory
      // plugin-fs 的 DirEntry 不包含 size，需通过 stat 获取
      let size = 0
      if (!isDir) {
        try {
          const stat = await fs.stat(fullPath)
          size = Number(stat.size)
        } catch { /* 忽略 stat 失败 */ }
      }
      results.push({ name: entry.name, path: fullPath, size, isDirectory: isDir })
      if (isDir) {
        await this.walkDir(fs, fullPath, results, depth + 1)
      }
    }
  }

  /** 通过 api/path 获取系统临时目录 */
  async getTempDir(): Promise<string> {
    const path = await getPath()
    return path.tempDir()
  }

  /** 通过 plugin-fs 全量读取后切片（替代原 Rust mmap） */
  async mmapRead(path: string, offset: number, length: number): Promise<Uint8Array> {
    await validatePath(path)
    const fs = await getFs()
    const data = await fs.readFile(path)
    return data.slice(offset, offset + length)
  }

  /** 流式读取（基于 plugin-fs 全量读取后包装为 ReadableStream） */
  streamRead(path: string): ReadableStream<Uint8Array> {
    return new ReadableStream<Uint8Array>({
      async start(controller) {
        try {
          const fs = await getFs()
          const data = await fs.readFile(path)
          controller.enqueue(data)
          controller.close()
        } catch (e) {
          controller.error(e)
        }
      }
    })
  }
}

/** Tauri 平台适配器全局单例 */
export default new TauriAdapter()
