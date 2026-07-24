import type { ICompressionPlugin } from '../types'
import { createExtensionMatcher } from '../helpers'
import type { FileEntry } from '@/types'

const EXTENSIONS = ['.zip']

/** zip bomb 防护：累计解压大小上限（1GB） */
const MAX_TOTAL_SIZE = 1_073_741_824

/**
 * 净化 zip 条目名称，拒绝路径穿越和非法字符
 * @param name - 原始条目名
 * @returns 净化后的条目名
 * @throws 条目名非法时抛出错误
 */
function sanitizeEntryName(name: string): string {
  if (name.includes('\\') || name.includes('..')) {
    throw new Error(`非法条目名: ${name}`)
  }
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f]/.test(name)) {
    throw new Error(`条目名包含控制字符: ${name}`)
  }
  return name
}

/** ZIP 压缩插件，统一使用 fflate 纯 JS 解压（Web/Tauri 通用） */
export const zipPlugin: ICompressionPlugin = {
  name: 'zip',
  supportedExtensions: EXTENSIONS,
  canHandle: createExtensionMatcher(EXTENSIONS),
  async decompress(data: Uint8Array, _outputDir: string) {
    try {
      const { unzip } = await import('fflate')
      const { memoryStore } = await import('@/core/memory-store')
      const files: FileEntry[] = []
      // 使用异步 unzip 替代 unzipSync，避免阻塞主线程
      const unzipped = await new Promise<Record<string, Uint8Array>>((resolve, reject) => {
        unzip(data, (err, result) => {
          if (err) reject(err)
          else resolve(result)
        })
      })

      // zip bomb 防护：检查累计解压大小
      let totalSize = 0
      for (const [name, content] of Object.entries(unzipped)) {
        const isDir = name.endsWith('/')
        if (!isDir) {
          totalSize += content.length
          if (totalSize > MAX_TOTAL_SIZE) {
            return {
              success: false,
              files: [],
              error: `累计解压大小超过上限 (${(totalSize / 1_048_576).toFixed(0)} MB > ${(MAX_TOTAL_SIZE / 1_048_576).toFixed(0)} MB)`,
            }
          }
        }
      }

      for (const [name, content] of Object.entries(unzipped)) {
        const isDir = name.endsWith('/')
        // zip slip 防护：净化条目名称
        const safeName = sanitizeEntryName(name)
        if (!isDir) {
          memoryStore.write(safeName, content)
        }
        files.push({
          name: safeName,
          path: safeName,
          size: isDir ? 0 : content.length,
          isDirectory: isDir,
        })
      }
      return { success: true, files }
    } catch (err) {
      return { success: false, files: [], error: err instanceof Error ? err.message : 'ZIP decompression failed' }
    }
  },
}
