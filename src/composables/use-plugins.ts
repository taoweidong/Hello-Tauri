import { PluginRegistry } from '@/plugins/registry'
import { registerBuiltinPlugins } from '@/plugins/manifest'
import type { FileEntry } from '@/types'

const registry = new PluginRegistry()
registerBuiltinPlugins(registry)

export function usePluginEngine() {
  return {
    registry,
    detect: (file: FileEntry) => registry.detect(file),
    getParser: (ext: string) => registry.getParser(ext),
    getCompression: (ext: string) => registry.getCompression(ext),
    enable: (name: string) => registry.enable(name),
    disable: (name: string) => registry.disable(name),
  }
}
