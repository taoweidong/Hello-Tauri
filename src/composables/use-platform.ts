import type { IPlatformAdapter } from '@/adapters/types'

let adapterPromise: Promise<IPlatformAdapter> | null = null

async function getAdapter(): Promise<IPlatformAdapter> {
  if (!adapterPromise) {
    if (__PLATFORM__ === 'tauri') {
      const mod = await import('@/adapters/tauri-adapter')
      adapterPromise = Promise.resolve(mod.default)
    } else {
      const mod = await import('@/adapters/web-adapter')
      adapterPromise = Promise.resolve(mod.default)
    }
  }
  return adapterPromise
}

export function usePlatform() {
  return {
    getAdapter,
    isTauri: __PLATFORM__ === 'tauri',
    isWeb: __PLATFORM__ === 'web',
  }
}
