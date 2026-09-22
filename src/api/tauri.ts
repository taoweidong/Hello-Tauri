import { invoke } from '@tauri-apps/api/core'

import type { AppInfo } from '@/types'
import type { Bridge } from './types'

export const tauriBridge: Bridge = {
  platform: 'tauri',
  loadConfig: () => invoke<string | null>('load_config'),
  saveConfig: (content) => invoke<void>('save_config', { content }),
  appInfo: () => invoke<AppInfo>('app_info'),
}
