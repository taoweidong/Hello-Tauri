import type { ICompressionPlugin } from '../types'
import { createExtensionMatcher, decompressViaTauri } from '../helpers'
import type { FileEntry } from '@/types'

const EXTENSIONS = ['.zip']

/** ZIP 压缩插件，Tauri 端调用后端解压，Web 端使用 fflate 纯 JS 解压 */
export const zipPlugin: ICompressionPlugin = {
  name: 'zip',
  supportedExtensions: EXTENSIONS,
  canHandle: createExtensionMatcher(EXTENSIONS),
  async decompress(data: Uint8Array, _outputDir: string) {
    // Tauri 平台：通过后端解压
    const tauriResult = await decompressViaTauri(data, 'zip', _outputDir)
    if (tauriResult) return tauriResult

    // Web 平台：使用 fflate 解压
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
      for (const [name, content] of Object.entries(unzipped)) {
        const isDir = name.endsWith('/')
        if (!isDir) {
          memoryStore.write(name, content)
        }
        files.push({
          name,
          path: name,
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
