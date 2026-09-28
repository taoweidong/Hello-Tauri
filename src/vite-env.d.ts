/// <reference types="vite/client" />

/**
 * 构建期注入的应用版本（R-3 单一来源）。
 *
 * 真值是 `package.json` 的 `version`，由 `vite.config.ts` 的 `define` 注入。
 * 不要在源码里硬编码版本字符串 —— 那正是本次要消除的「多份真值」问题。
 */
declare const __APP_VERSION__: string
