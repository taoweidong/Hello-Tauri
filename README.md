# Hello-Tauri

Tauri 2 + Vue 3 + Element Plus 的 Windows 桌面应用模板，一次打包产出**单文件 exe**，面向内网离线环境设计。

## 需求说明

设计一个系统 使用 Tauri 框架开发一个 winodws 客户端程序，打包成一个独立 exe，要求资源占用少
使用 vue3 开发前端，布局选择 elemnet-ui-plus 组件，核心业务逻辑使用 TS 语言开发，rust 制作打包和桥接，注意尽量减少使用 rust，主力语言使用 TS，
页面支持 4 个页面，配置，表格增删改查，等示例页面，即可
注意设计系统的目录结构 前后端 和 rust 相互独立
开发支持一键式打包的脚本，支持一件打包成 exe
布局采用左右布局
注意：程序当前是在网络正常的环境下开发，需要考虑后续在内网运行的场景，除了 npm rust 环境正产外，如果依赖外部的文件下载，尽量避免

## 技术栈

| 层次 | 选型 |
| --- | --- |
| 桌面容器 | Tauri 2（Rust，仅窗口与桥接） |
| 前端框架 | Vue 3 + TypeScript + Vite |
| UI 组件 | Element Plus（中文语言包） |
| 状态管理 | Pinia |
| 业务逻辑 | 100% TypeScript |

## 目录结构

前后端与 Rust 三层完全解耦，前端不直接依赖 Rust，通过桥接层适配。

```
├── src/                      # 前端源码（全部业务逻辑）
│   ├── api/                  # 桥接层：屏蔽"桌面 / 浏览器"差异
│   │   ├── types.ts          #   Bridge 接口定义
│   │   ├── tauri.ts          #   Tauri 实现（invoke 调用 Rust）
│   │   ├── web.ts            #   Web 实现（localStorage）
│   │   └── index.ts          #   运行时自动选择实现
│   ├── layouts/MainLayout.vue# 左右布局：左侧菜单 + 右侧内容
│   ├── views/                # 4 个页面
│   │   ├── DashboardView.vue #   概览
│   │   ├── TableCrudView.vue #   表格增删改查
│   │   ├── SettingsView.vue  #   配置
│   │   └── AboutView.vue     #   关于
│   ├── stores/               # Pinia：应用配置、表格业务规则
│   ├── router/               # 路由（hash 模式）
│   └── styles/               # 全局样式（系统字体，无在线字体）
├── src-tauri/                # Rust 薄桥接层（仅 3 个命令）
│   ├── src/commands.rs       #   load_config / save_config / app_info
│   ├── src/lib.rs            #   Builder 注册
│   ├── src/main.rs           #   入口（release 隐藏控制台）
│   ├── capabilities/         #   权限：仅 core:default
│   └── tauri.conf.json       #   bundle.active=false → 只产出裸 exe
├── scripts/build.mjs         # 一键打包脚本
└── release/                  # 打包产物（生成的单文件 exe）
```

**职责边界**：Rust 只做「开窗口 + 读写一个配置文件」，无任何业务规则；新增功能全部写在 `src/` 的 TypeScript 中，不需要改动 Rust。

## 快速开始

```bash
npm install            # 安装依赖（需 Node.js >= 20）

npm run dev            # 浏览器开发模式，无需 Rust，可直接调试全部页面
npm run tauri:dev      # 桌面开发模式，需要 Rust 工具链
```

浏览器模式下 `src/api/web.ts` 会把配置写入 `localStorage`，因此没有 Rust 环境也能完整开发与联调。

## 一键打包

```bash
npm run pack
```

脚本依次执行：类型检查 → 前端构建 → `tauri build` → 拷贝为 `release/Hello-Tauri-0.1.0-x64.exe`。

采用 `bundle.active = false`，**只产出裸 exe，不生成 NSIS/WiX 安装包**，因此打包过程不下载任何额外组件。产物为绿色单文件，复制到任意 Windows 机器双击即可运行（系统需自带 WebView2 运行时，Win10 1803+ 与 Win11 已内置）。

## 内网运行说明

- 运行期**零外部请求**：无 CDN 字体/图标、无更新检查、无遥测；图标为内联 SVG 组件，字体使用系统字体栈。
- 所有资源经 Vite 打包进 exe，页面刷新与路由（hash 模式）均在本地完成。
- 配置写在 `%APPDATA%\com.taowd.hello-tauri\config.json`，不依赖网络与外部服务。
- 开发环境之外，目标机器**不需要** Node.js、Rust 或 npm。

## 常用命令

| 命令 | 说明 |
| --- | --- |
| `npm run dev` | 浏览器开发模式 |
| `npm run tauri:dev` | 桌面开发模式 |
| `npm run typecheck` | TypeScript 类型检查 |
| `npm run build:web` | 仅构建前端静态资源 |
| `npm run pack` | 一键打包单文件 exe |
| `npm run tauri:build` | 仅执行 Tauri 编译（不拷贝产物） |
