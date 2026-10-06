/**
 * `scripts/version-meta.mjs` 的类型声明。
 *
 * vite.config.ts 在 tsconfig include 内、会被 vue-tsc 以 strict 检查；该模块是
 * 给 Node 构建脚本用的纯 JS，类型在这里手工对齐，避免 TS7016（隐式 any）。
 */
export declare const APP_VERSION: string
export declare const GIT_COMMIT: string
export declare const BUILD_TIME: string
export declare function formatBuildTime(date: Date): string
export declare function formatBuildStamp(date: Date): string
