import type { ICompressionPlugin, IFileParserPlugin, ParsedResult } from './types'
import type { DecompressResult, FileEntry } from '@/adapters/types'

const PLUGIN_TIMEOUT_MS = 30000

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error('Plugin timeout')), ms) }),
  ])
}

export class PluginRegistry {
  private compressionPlugins = new Map<string, ICompressionPlugin>()
  private parserPlugins = new Map<string, IFileParserPlugin>()
  private extToParser = new Map<string, string>()
  private extToCompression = new Map<string, string>()
  private disabled = new Set<string>()

  registerParser(plugin: IFileParserPlugin): void {
    this.parserPlugins.set(plugin.name, plugin)
    for (const ext of plugin.supportedExtensions) {
      this.extToParser.set(ext, plugin.name)
    }
  }

  registerCompression(plugin: ICompressionPlugin): void {
    this.compressionPlugins.set(plugin.name, plugin)
    for (const ext of plugin.supportedExtensions) {
      this.extToCompression.set(ext, plugin.name)
    }
  }

  getParser(ext: string): IFileParserPlugin | null {
    const name = this.extToParser.get(ext)
    if (!name || this.disabled.has(name)) return null
    return this.parserPlugins.get(name) ?? null
  }

  getCompression(ext: string): ICompressionPlugin | null {
    const name = this.extToCompression.get(ext)
    if (!name || this.disabled.has(name)) return null
    return this.compressionPlugins.get(name) ?? null
  }

  detect(file: FileEntry): IFileParserPlugin | null {
    for (const [ext, name] of this.extToParser) {
      if (file.name.endsWith(ext) && !this.disabled.has(name)) {
        return this.parserPlugins.get(name) ?? null
      }
    }
    return null
  }

  detectCompression(file: FileEntry): ICompressionPlugin | null {
    for (const [ext, name] of this.extToCompression) {
      if (file.name.endsWith(ext) && !this.disabled.has(name)) {
        return this.compressionPlugins.get(name) ?? null
      }
    }
    return null
  }

  enable(name: string): void {
    this.disabled.delete(name)
  }

  disable(name: string): void {
    this.disabled.add(name)
  }

  async safeParse(plugin: IFileParserPlugin, data: Uint8Array, options?: Record<string, any>): Promise<ParsedResult> {
    try {
      return await withTimeout(plugin.parse(data, options), PLUGIN_TIMEOUT_MS)
    } catch {
      return { type: 'hex', data: data }
    }
  }

  async safeDecompress(plugin: ICompressionPlugin, data: Uint8Array, outputDir: string): Promise<DecompressResult> {
    try {
      return await withTimeout(plugin.decompress(data, outputDir), PLUGIN_TIMEOUT_MS)
    } catch (err) {
      return {
        success: false,
        files: [],
        error: err instanceof Error ? err.message : 'Unknown error',
      }
    }
  }
}
