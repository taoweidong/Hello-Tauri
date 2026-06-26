/// <reference types="vite/client" />

declare const __PLATFORM__: 'web' | 'tauri'

declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<Record<string, never>, Record<string, never>, any>
  export default component
}
