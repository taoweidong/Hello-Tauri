/// <reference types="vite/client" />

/** 编译时平台标识，由 Vite define 注入，值为 'web' 或 'tauri' */
declare const __PLATFORM__: 'web' | 'tauri'

declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<Record<string, never>, Record<string, never>, any>
  export default component
}

declare module 'splitpanes' {
  import type { DefineComponent } from 'vue'
  export const Splitpanes: DefineComponent<any, any, any>
  export const Pane: DefineComponent<any, any, any>
}
