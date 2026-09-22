import { tauriBridge } from './tauri'
import { webBridge } from './web'
import type { Bridge, Platform } from './types'

const isTauriRuntime = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

export const bridge: Bridge = isTauriRuntime ? tauriBridge : webBridge
export const platform: Platform = bridge.platform

export type { Bridge, Platform } from './types'
