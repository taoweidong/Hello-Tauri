import type { ICompressionPlugin } from '../types'
import { createExtensionMatcher, decompressViaTauri } from '../helpers'

const EXTENSIONS = ['.gz', '.gzip', '.tgz']

/** Gzip 压缩插件，Tauri 端调用后端解压，Web 端使用 DecompressionStream API */
export const gzipPlugin: ICompressionPlugin = {
  name: 'gzip',
  supportedExtensions: EXTENSIONS,
  canHandle: createExtensionMatcher(EXTENSIONS),
  async decompress(data: Uint8Array, _outputDir: string, file?: { name: string }) {
    // 从原始文件名推断输出名，去掉 .gz/.gzip/.tgz 后缀
    const rawName = file?.name ?? 'decompressed'
    const outputName = rawName.replace(/\.(gz|gzip|tgz)$/i, '') || 'decompressed'

    // Tauri 平台：通过后端解压
    const tauriResult = await decompressViaTauri(data, 'gzip', _outputDir, outputName)
    if (tauriResult) return tauriResult

    // Web 平台：使用 DecompressionStream API
    if (typeof DecompressionStream !== 'undefined') {
      const ds = new DecompressionStream('gzip')
      const writer = ds.writable.getWriter()
      const reader = ds.readable.getReader()
      writer.write(data as BufferSource)
      writer.close()
      const chunks: Uint8Array[] = []
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        chunks.push(value)
      }
      const total = chunks.reduce((acc, c) => acc + c.length, 0)
      const result = new Uint8Array(total)
      let offset = 0
      for (const chunk of chunks) {
        result.set(chunk, offset)
        offset += chunk.length
      }
      // 将解压结果写入内存存储，供后续 readFile 使用
      const { memoryStore } = await import('@/core/memory-store')
      memoryStore.write(outputName, result)
      return {
        success: true,
        files: [{ name: outputName, path: outputName, size: result.length, isDirectory: false }],
      }
    }
    return { success: false, files: [], error: 'Gzip 解压不可用' }
  },
}
