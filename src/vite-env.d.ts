/// <reference types="vite/client" />

/**
 * 构建期注入的应用版本（R-3 单一来源）。
 *
 * 真值是 `package.json` 的 `version`，计算逻辑集中在 `scripts/version-meta.mjs`
 * （vite / vitest / build.mjs 三处共享）。不要在源码里硬编码版本字符串 ——
 * 那正是 R-3 要消除的「多份真值」问题。
 */
declare const __APP_VERSION__: string

/**
 * 构建期注入的 git 节点（HEAD 前 6 位）：当前版本基于哪个提交。
 * 非 git 环境构建时为空串，UI 按「未提供」处理（显示 `-` / 隐藏该段）。
 */
declare const __GIT_COMMIT__: string

/**
 * 构建期注入的打包时间（本地时区 `YYYY-MM-DD HH:mm`）。
 * `npm run pack` 时与 exe 文件名里的时间戳同源（build.mjs 经环境变量传入）。
 */
declare const __BUILD_TIME__: string
