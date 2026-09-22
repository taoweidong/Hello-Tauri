import type { AppInfo } from '@/types'
import type { Bridge } from './types'

const STORAGE_KEY = 'hello-tauri:config'

export const webBridge: Bridge = {
  platform: 'web',
  async loadConfig() {
    return localStorage.getItem(STORAGE_KEY)
  },
  async saveConfig(content) {
    localStorage.setItem(STORAGE_KEY, content)
  },
  async appInfo() {
    return {
      name: 'Hello-Tauri',
      version: '0.1.0',
      tauriVersion: '-',
      platform: 'web',
      arch: '-',
      configPath: `localStorage://${STORAGE_KEY}`,
    } satisfies AppInfo
  },
}
