import type { ICompressionPlugin } from '../types'
import type { FileEntry } from '@/adapters/types'

export const zipPlugin: ICompressionPlugin = {
  name: 'zip',
  supportedExtensions: ['.zip'],
  canHandle(file: FileEntry): boolean {
    return file.name.endsWith('.zip')
  },
  async decompress(data: Uint8Array, _outputDir: string) {
    if (__PLATFORM__ === 'tauri') {
      const { usePlatform } = await import('@/composables/use-platform')
      const { getAdapter } = usePlatform()
      const adapter = await getAdapter()
      return adapter.decompress(data, 'zip', _outputDir)
    }
    return { success: false, files: [], error: 'ZIP decompression requires Tauri backend or WASM module' }
  },
}
