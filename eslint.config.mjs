// ESLint 扁平配置（flat config）—— 质量报告 R-1：本项目此前**无任何 lint**。
//
// 设计取舍：ESLint 在本项目里的定位是「**抓住真问题**」，不是「统一风格」。
// 风格交给 Prettier（见 .prettierrc.json），因此这里用 eslint-config-prettier
// 关掉所有与格式相关的规则，避免两个工具互相打架、也避免制造大量无意义 diff。
//
// 规则集只挑三类：
//  1. **会用错的**：`no-unused-vars`（含 `_` 前缀豁免）、`eqeqeq`、
//     `no-var`、Vue 的 `vue/multi-word-component-names` 之外的模板正确性规则；
//  2. **会造成 bug 的 async**：`require-await` 之外，保留 tseslint 的
//     recommended（它抓 `no-floating-promises` 之外的多数类型相关陷阱）；
//  3. **项目自身不变量**：`no-restricted-imports` 禁止前端直接 import
//     `@tauri-apps/api` —— 宿主交互必须走 `src/api` 的 Bridge（架构约定，
//     写在这里等于给架构约束装了一道 CI 闸）。
import { readFileSync } from 'node:fs'

import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import pluginVue from 'eslint-plugin-vue'
import prettier from 'eslint-config-prettier'

/**
 * `unplugin-auto-import` 生成的全局声明（`.eslintrc-auto-import.json`）。
 *
 * 为什么需要：按需引入（P-1）后 `ref` / `computed` / `onMounted` 等**不再需要
 * 手写 import**，由插件在构建期注入。ESLint 看不到注入过程，会把它们判成
 * `no-undef`。这个文件就是插件自己吐出的 globals 清单，直接读进来即可
 * （缺文件时降级为空对象 —— 首次 clone 后未跑过构建也不能让 lint 直接崩）。
 */
const autoImportGlobals = (() => {
  try {
    return JSON.parse(readFileSync(new URL('./.eslintrc-auto-import.json', import.meta.url), 'utf8')).globals ?? {}
  } catch {
    return {}
  }
})()

export default tseslint.config(
  // 产物与依赖一律不检查（dist / release 是构建输出，target 是 Rust 产物）
  { ignores: ['dist/**', 'release/**', 'target/**', 'src-tauri/**', 'node_modules/**', 'vibe_images/**'] },

  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...pluginVue.configs['flat/recommended'],

  {
    files: ['**/*.vue'],
    languageOptions: {
      parserOptions: {
        // .vue 里的 <script lang="ts"> 交给 TS 解析器，模板交给 vue-eslint-parser
        parser: tseslint.parser,
        extraFileExtensions: ['.vue'],
      },
    },
  },

  {
    files: ['**/*.{ts,vue,mjs}'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: {
        // 浏览器 + Node 混合环境：src 跑在 WebView 里，scripts 跑在 Node 里。
        // 不引入 globals 包（多一个依赖），按需列出手头真正用到的。
        window: 'readonly',
        document: 'readonly',
        localStorage: 'readonly',
        navigator: 'readonly',
        console: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        fetch: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        TextEncoder: 'readonly',
        TextDecoder: 'readonly',
        AbortController: 'readonly',
        AbortSignal: 'readonly',
        WebSocket: 'readonly',
        Blob: 'readonly',
        process: 'readonly',
        Buffer: 'readonly',
        __dirname: 'readonly',
        global: 'readonly',
        // Vite `define` 注入的构建期常量（R-3：版本元数据，真值在 scripts/version-meta.mjs）。
        // 运行时并不存在这些全局，是构建时被字面量替换掉的 —— 但 ESLint 看不到
        // 替换过程，只看到「用了未定义的变量」。声明为 readonly 才能过 no-undef。
        __APP_VERSION__: 'readonly',
        __GIT_COMMIT__: 'readonly',
        __BUILD_TIME__: 'readonly',
        // `unplugin-auto-import` 注入的 Vue / vue-router / pinia API（P-1 按需引入）
        ...autoImportGlobals,
      },
    },
    rules: {
      // —— 真问题优先 ——
      'no-unused-vars': 'off', // 交给 TS 版本（能理解类型与 `_` 前缀）
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-var': 'error',
      'prefer-const': 'error',
      'no-console': 'off', // logger.ts 是唯一出口，但脚本与测试允许直接打
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-non-null-assertion': 'off',

      // —— 项目架构不变量（改成 CI 可拦） ——
      // 前端**不得**直接调 Tauri API：宿主交互统一走 src/api 的 Bridge，
      // 这样浏览器调试模式才能用 web.ts 顶掉 tauri.ts（D8 依赖方向）。
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@tauri-apps/api',
              message: '请通过 src/api 的 Bridge 访问宿主（前端不直接依赖 Rust/Tauri）。',
            },
          ],
          patterns: [
            {
              group: ['@tauri-apps/api/*'],
              message: '请通过 src/api 的 Bridge 访问宿主（前端不直接依赖 Rust/Tauri）。',
            },
          ],
        },
      ],
    },
  },

  // src/api/tauri.ts 是**唯一**允许直连 Tauri 的地方（Bridge 的桌面实现）
  {
    files: ['src/api/tauri.ts'],
    rules: { 'no-restricted-imports': 'off' },
  },

  // —— 分层闸门（quality-hardening-2026-10 D4）——
  // UI 层（views/components）禁止直触 infra / repositories：宿主与数据访问一律
  // 经 stores（组合点例外与口径见 AGENTS.md「TS 内部分层」）。V1/V2/V3 已清零，
  // 本规则是防回流的机器闸。
  {
    files: ['src/views/**/*.{ts,vue}', 'src/components/**/*.{ts,vue}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@/infra', '@/infra/**', '@/repositories', '@/repositories/**'],
              message:
                'UI 层（views/components）禁止直触 infra/repositories —— 一律经 stores（AGENTS.md「TS 内部分层」；quality-hardening-2026-10 D4）。',
            },
          ],
        },
      ],
    },
  },

  // 测试文件放宽：允许非空断言、允许 any（构造边界数据）
  {
    files: ['**/*.spec.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },

  // 命令行报告脚本（verify / uitest / smoke）放宽两条：
  //  * `no-control-regex`：stripAnsi 必须匹配 `\x1b[...m` 控制序列，这是功能本身；
  //  * `no-irregular-whitespace`：报告表格用**全角空格**（U+3000）对齐中文列宽，
  //    换成半角空格会让表格歪掉（visualWidth 按中文占两列算）。
  {
    files: ['scripts/**/*.mjs'],
    rules: {
      'no-control-regex': 'off',
      'no-irregular-whitespace': 'off',
    },
  },

  // icons.ts 是 `defineComponent` 图标**工厂**（makeIcon 返回组件），
  // 文件里出现多个组件符号是设计本身，不是「一个文件塞多个组件」。
  {
    files: ['src/components/icons.ts'],
    rules: { 'vue/one-component-per-file': 'off' },
  },

  prettier,
)
