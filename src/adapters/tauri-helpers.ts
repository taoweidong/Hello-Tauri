/**
 * Tauri 插件懒加载工具（tauri-adapter 与 cache-fs 共用）
 * 避免在非 Tauri 环境中直接 import 导致报错
 */

/** 懒加载的 fs 插件模块缓存 */
let fsModule: typeof import('@tauri-apps/plugin-fs') | null = null
/** 懒加载的 path 模块缓存 */
let pathModule: typeof import('@tauri-apps/api/path') | null = null

/** 获取 @tauri-apps/plugin-fs 模块单例 */
export async function getFs() {
  if (!fsModule) {
    fsModule = await import('@tauri-apps/plugin-fs')
  }
  return fsModule
}

/** 获取 @tauri-apps/api/path 模块单例 */
export async function getPath() {
  if (!pathModule) {
    pathModule = await import('@tauri-apps/api/path')
  }
  return pathModule
}
