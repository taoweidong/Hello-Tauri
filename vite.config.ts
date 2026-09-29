import { fileURLToPath, URL } from 'node:url'
import { readFileSync } from 'node:fs'

import vue from '@vitejs/plugin-vue'
import AutoImport from 'unplugin-auto-import/vite'
import Components from 'unplugin-vue-components/vite'
import { ElementPlusResolver } from 'unplugin-vue-components/resolvers'
import { defineConfig } from 'vite'

const devHost = process.env.TAURI_DEV_HOST

/**
 * 版本号单一来源（R-3）。
 *
 * 此前 `0.1.0` 硬编码在 5 处（`web.ts`、`MainLayout.vue`、`AboutView.vue`、
 * `tauri.conf.json`、`Cargo.toml`），发版时要手工同步 —— 漏一处就出现
 * 「界面显示 0.1.0 但关于页写 0.2.0」这种一眼假的信息。
 *
 * 现在以 `package.json` 为唯一真值，构建期注入常量：
 *  * 前端：`__APP_VERSION__`（见 `src/vite-env.d.ts` 的声明）
 *  * Rust 侧：`tauri.conf.json` 的 version 由 tauri 自身读取，无法共享同一份
 *    文件，因此保留在那里，由 `scripts/build.mjs` 打包入口做一致性硬校验
 *    （评审 B-3：此处注释曾声称 verify.mjs 有该断言，实际不存在——不实注释
 *    制造的兜底假象比没有兜底更危险，现已在 build.mjs 落地）。
 */
const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string }

export default defineConfig({
  base: './',
  plugins: [
    vue(),
    /**
     * Element Plus 按需引入（P-1）。
     *
     * 此前 `main.ts` 全量 `use(ElementPlus)` + 全量 CSS，主 chunk 1.06 MB ——
     * 与「轻量 Windows 桌面模板」的定位直接冲突（冷启动要解析整包）。
     *
     * 三个插件各管一段（缺一不可）：
     *  * `AutoImport`：把 `ElMessage` / `ElMessageBox` 这类**命令式 API** 从
     *    `import { ElMessage } from 'element-plus'` 改写为按需的
     *    `element-plus/es/components/message/...`，并顺带引入其样式。
     *    没有它，只要有一处显式 import 就会把**整包**拉回产物。
     *  * `Components`：模板里的 `<el-button>` 等**组件**按需解析 + 按需样式。
     *  * `ElementPlusResolver({ importStyle: 'css' })`：用 CSS 而非 Sass ——
     *    项目不装 sass，且内网离线打包下少一层编译依赖更稳。
     *
     * `dts` 生成 TS 声明文件：`auto-imports.d.ts` / `components.d.ts` 会被
     * **提交进仓库**（否则 CI 上首跑 typecheck 会因缺声明而失败），
     * 因此 `.gitignore` 里不能忽略它们。`eslintrc` 自动生成同理。
     */
    AutoImport({
      imports: ['vue', 'vue-router', 'pinia'],
      resolvers: [ElementPlusResolver({ importStyle: 'css' })],
      dts: 'auto-imports.d.ts',
      eslintrc: { enabled: true, filepath: '.eslintrc-auto-import.json' },
    }),
    Components({
      resolvers: [ElementPlusResolver({ importStyle: 'css' })],
      dts: 'components.d.ts',
    }),
  ],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: devHost || false,
    hmr: devHost ? { protocol: 'ws', host: devHost, port: 1421 } : undefined,
    watch: { ignored: ['**/src-tauri/**'] },
  },
  build: {
    target: 'esnext',
    outDir: 'dist',
    emptyOutDir: true,
    /**
     * 分包（P-1）：把不随业务改动的大依赖拆成独立 chunk。
     *
     * 收益不只是「首次加载快」，更重要的是**缓存命中**：改一行业务代码后，
     * 只有业务 chunk 失效，vendor（vue / element-plus）保持 SHA 不变。
     * 单文件 exe 内是本地文件协议，没有 HTTP 缓存，但 Vite 的
     * `import` 图仍会让未变更 chunk 在**重复打包时保持字节一致**，
     * 便于比对产物差异。
     *
     * 注意 Vite 8 走 rolldown，`manualChunks` **必须是函数**（对象形态已不支持，
     * 会直接报 `manualChunks is not a function` 并中断构建）。
     */
    rollupOptions: {
      output: {
        manualChunks(id: string) {
          if (!id.includes('node_modules')) return undefined
          // 只把 vue 全家桶钉成独立包：版本最稳定、缓存价值最高，且它本身很小。
          //
          // 刻意**不**给 `element-plus` 指定 manualChunk —— 试过之后发现那样反而
          // 更差：Element Plus 的组件被多个路由 chunk 共用，手动归并会让整个
          // element-plus（564 KB）变成**启动即加载**。交给 rolldown 按路由图
          // 自然切分，各页只加载自己用到的组件（见构建产物的分页 chunk）。
          if (/[\\/]node_modules[\\/](vue|vue-router|pinia|@vue)[\\/]/.test(id)) return 'vue'
          return undefined
        },
      },
    },
    // 按需引入后**没有任何 chunk 超过 200 kB**（实测最大 ~160 kB）；
    // 阈值从 900 收到 300 作为**回归门** —— 若将来有人误把整包引回来
    // （例如在 main.ts 里加回 `use(ElementPlus)`），构建会立刻告警而不是悄悄变胖。
    chunkSizeWarningLimit: 300,
  },
})
