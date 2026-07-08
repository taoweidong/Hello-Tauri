import type { IPlatformAdapter } from '@/adapters/types'

/** 适配器加载 Promise 缓存（单例） */
let adapterPromise: Promise<IPlatformAdapter> | null = null

/**
 * 获取平台适配器实例（懒加载单例）
 * 根据 __PLATFORM__ 编译时常量决定加载 Tauri 或 Web 适配器
 * 加载失败时重置缓存，允许下次调用重试
 * @returns 平台适配器实例
 */
async function getAdapter(): Promise<IPlatformAdapter> {
  if (!adapterPromise) {
    adapterPromise = (async () => {
      if (__PLATFORM__ === 'tauri') {
        const mod = await import('@/adapters/tauri-adapter')
        return mod.default
      } else {
        const mod = await import('@/adapters/web-adapter')
        return mod.default
      }
    })()
    // 加载失败时重置缓存，允许下次调用重试
    adapterPromise.catch(() => {
      adapterPromise = null
    })
  }
  return adapterPromise
}

/** 平台能力 composable，提供适配器访问与平台判断 */
export function usePlatform() {
  return {
    /** 获取平台适配器实例 */
    getAdapter,
    /** 当前是否为 Tauri 桌面端 */
    isTauri: __PLATFORM__ === 'tauri',
    /** 当前是否为 Web 端 */
    isWeb: __PLATFORM__ === 'web',
  }
}
