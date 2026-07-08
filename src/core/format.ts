/**
 * 通用格式化工具函数
 */

/**
 * 将字节数格式化为人类可读的字符串（如 "1.5 MB"）
 * @param bytes - 字节数
 * @returns 格式化后的文件大小字符串
 */
export function formatSize(bytes: number): string {
  // 边界保护：负数、NaN、Infinity
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B'
  if (bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), sizes.length - 1)
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i]
}

/**
 * 将毫秒数格式化为人类可读的耗时字符串
 * @param ms - 耗时毫秒数
 * @returns 格式化后的耗时字符串（如 "1.23 s" 或 "456 ms"）
 */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms} ms`
  return `${(ms / 1000).toFixed(2)} s`
}
