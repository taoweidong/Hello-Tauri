import type { ICompressionPlugin } from '../types'
import { matchesAnyExtension } from '../types'
import type { FileEntry } from '@/types'

/** ZIP 压缩插件，Tauri 端调用后端解压，Web 端使用 fflate 纯 JS 解压 */
export const zipPlugin: ICompressionPlugin = {
  name: 'zip',
  supportedExtensions: ['.zip'],
  canHandle(file: FileEntry): boolean {
    return matchesAnyExtension(file.name, this.supportedExtensions)
  },
  async decompress(data: Uint8Array, _outputDir: string) {
    if (__PLATFORM__ === 'tauri') {
      const { usePlatform } = await import('@/composables/use-platform')
      const { getAdapter } = usePlatform()
      const adapter = await getAdapter()
      return adapter.decompress(data, 'zip', _outputDir)
    }
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
