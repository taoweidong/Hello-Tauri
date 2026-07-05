import type { IPlatformAdapter } from '@/adapters/types'

/** 适配器加载 Promise 缓存（单例） */
let adapterPromise: Promise<IPlatformAdapter> | null = null

/**
 * 获取平台适配器实例（懒加载单例）
 * 根据 __PLATFORM__ 编译时常量决定加载 Tauri 或 Web 适配器
 * @returns 平台适配器实例
 */
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
