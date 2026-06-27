import type { IPlatformAdapter, DecompressResult, FileEntry } from '@/adapters/types'
import type { PluginRegistry } from '@/plugins/registry'

export class DecompressService {
  constructor(
    private adapter: IPlatformAdapter,
    private registry: PluginRegistry
  ) {}

  async decompress(data: Uint8Array, fileName: string, outputDir: string): Promise<DecompressResult> {
    const fileEntry: FileEntry = {
      name: fileName,
      path: fileName,
      size: data.length,
      isDirectory: false,
    }

    const plugin = this.registry.detectCompression(fileEntry)
    if (!plugin) {
      return { success: false, files: [], error: `No compression plugin for: ${fileName}` }
    }

    return this.registry.safeDecompress(plugin, data, outputDir)
  }
}
