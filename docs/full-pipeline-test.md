# 全流程测试方案

> 本文档定义了 Hello-Tauri 项目从单元测试到 EXE 打包的完整测试流水线。
> 支持 AI Agent 按阶段自动调用执行。

## 概览

| 阶段 | 名称 | 命令 | 通过标准 |
|------|------|------|----------|
| P1 | 单元测试 | `npx vitest run` | 所有测试文件通过，0 失败 |
| P2 | 类型检查 | `npx vue-tsc --noEmit` | 退出码 0，无类型错误 |
| P3 | Web 构建 | `npm run build` | 退出码 0，`build/web/` 产物生成 |
| P4 | Rust 检查 | `cargo check` (workdir: src-tauri/) | 编译无错误 |
| P5 | Rust 测试 | `cargo test` (workdir: src-tauri/) | 所有测试通过 |
| P6 | Tauri EXE 打包 | `npm run tauri:build` | 退出码 0，EXE 文件生成 |
| P7 | Web E2E 自动化测试 | `npx playwright test` | 所有场景通过 |

---

## Agent 调用协议

Agent 执行全流程测试时，按以下规则操作：

```
1. 按 P1 → P7 顺序依次执行
2. 每个阶段执行后检查退出码和输出
3. 若某阶段失败：
   a. 分析错误输出
   b. 修复代码问题
   c. 重新执行该阶段直到通过
   d. 继续下一阶段
4. 所有阶段通过后输出汇总报告
```

### 快速执行脚本（一键全流程）

```powershell
# 在项目根目录执行
cd e:\GitHub\Hello-Tauri

# P1: 单元测试
npx vitest run

# P2: 类型检查
npx vue-tsc --noEmit

# P3: Web 构建
npm run build

# P4 + P5: Rust 检查与测试
cd src-tauri
$env:PATH = "$env:USERPROFILE\.cargo\bin;$env:PATH"
$env:https_proxy = ""; $env:no_proxy = "*"
cargo check
cargo test
cd ..

# P6: Tauri EXE 打包
npm run tauri:build

# P7: Web E2E 测试
npx playwright test
```

---

## P1: 单元测试

### 配置

- 框架：Vitest 4.x + jsdom + @vue/test-utils
- 配置文件：`vitest.config.ts`
- 测试目录：`src/__tests__/`
- Setup 文件：`src/__tests__/setup.ts`（mock 缓存、polyfill DataTransfer/DragEvent/matchMedia）

### 执行命令

```bash
# 全量运行
npx vitest run

# 带覆盖率
npx vitest run --coverage

# 单文件运行
npx vitest run src/__tests__/core/search.test.ts

# Watch 模式
npm run test:watch
```

### 测试覆盖范围

| 模块 | 目录 | 说明 |
|------|------|------|
| 核心逻辑 | `src/__tests__/core/` | decompress、file-tree、search、parser-engine、task-scheduler 等 |
| 组合式函数 | `src/__tests__/composables/` | use-archives、use-tabs、use-search、use-decompress 等 |
| 组件 | `src/__tests__/components/` | ArchiveCard、DataTable、FileTree、GlobalSearch、TabBar 等 |
| 插件 | `src/__tests__/plugins/` | csv/json/log/text/hex/zip/gzip 解析与压缩插件 |
| 渲染器 | `src/__tests__/views/renderers/` | CsvRenderer、JsonRenderer、LogRenderer、TextRenderer 等 |
| Store | `src/__tests__/stores/` | Pinia app store |
| 配置 | `src/__tests__/config/` | 布局常量、快捷键配置 |

### 通过标准

- 所有测试文件状态为 `passed`
- 失败数为 0
- 覆盖率目标：语句覆盖 ≥ 80%

### 常见失败修复

| 错误类型 | 修复方式 |
|----------|----------|
| 模块级状态泄漏 | 在 `beforeEach` 中调用对应 `reset()` |
| jsdom 缺少 API | 在 `setup.ts` 中添加 polyfill |
| 异步超时 | 使用 `vi.useFakeTimers()` 或增加 timeout |
| 快照不匹配 | 更新快照 `npx vitest run -u` |

---

## P2: 类型检查

### 执行命令

```bash
npx vue-tsc --noEmit
```

### 配置

- `tsconfig.json`：主配置（strict 模式，路径别名 `@/` → `src/`）
- `tsconfig.node.json`：Node 端配置（`skipLibCheck: true`）

### 通过标准

- 退出码为 0
- 无 TS 错误输出

### 常见错误修复

| 错误代码 | 说明 | 修复 |
|----------|------|------|
| TS2339 | 属性不存在 | 检查类型声明或添加类型断言 |
| TS2345 | 参数类型不匹配 | 修正函数签名或调用参数 |
| TS2307 | 模块未找到 | 检查路径别名或安装依赖 |
| TS7006 | 隐式 any | 添加显式类型注解 |

---

## P3: Web 构建

### 执行命令

```bash
npm run build
# 等价于: vue-tsc -b && vite build
```

### 产物

- 输出目录：`build/web/`
- 入口文件：`build/web/index.html`
- 静态资源：`build/web/assets/`

### 通过标准

- 退出码为 0
- `build/web/index.html` 存在
- 无编译错误（警告可接受）

### 可接受的警告

| 警告 | 原因 | 处理 |
|------|------|------|
| INVALID_ANNOTATION | @vueuse/core 的 `#__PURE__` 注释位置 | 第三方库问题，忽略 |
| INEFFECTIVE_DYNAMIC_IMPORT | 模块同时被静态和动态导入 | 优化项，不阻塞 |
| chunk > 500kB | 主包体积较大 | 后续优化代码分割 |

---

## P4: Rust 检查

### 环境准备（Windows）

```powershell
$env:PATH = "$env:USERPROFILE\.cargo\bin;$env:PATH"
$env:https_proxy = ""; $env:no_proxy = "*"
```

### 执行命令

```bash
cd src-tauri
cargo check
```

### 通过标准

- 输出包含 `Finished` 字样
- 无 `error[E...]` 编译错误

### 注意事项

- PowerShell 中 cargo 的 stderr 输出会导致 `ExitCode:1` 假阳性，需检查实际输出内容
- 首次编译需下载依赖，可能耗时较长

---

## P5: Rust 测试

### 执行命令

```bash
cd src-tauri
cargo test
```

### 通过标准

- 输出 `test result: ok`
- 失败数为 0

---

## P6: Tauri EXE 打包

### 前置条件

- P3（Web 构建）已通过
- P4（Rust 检查）已通过
- Rust 工具链已安装（rustc、cargo）
- Windows SDK（MSVC 链接器）

### 执行命令

```bash
npm run tauri:build
```

### 产物

- 输出目录：`src-tauri/target/release/bundle/`
- EXE 文件：`src-tauri/target/release/日志解析工具.exe`（或 `hello-tauri.exe`）

### 通过标准

- 退出码为 0
- EXE 文件存在且大小 > 1MB
- 无编译错误

### 配置说明

- `tauri.conf.json` 中 `"targets": []` 跳过安装包（WiX/NSIS）生成
- `beforeBuildCommand: "npm run build"` 会自动先执行前端构建
- 窗口配置：1400×900，最小 800×600

### 常见失败修复

| 错误 | 修复 |
|------|------|
| linker not found | 安装 Visual Studio Build Tools (MSVC) |
| cargo 网络超时 | 设置 `$env:https_proxy = ""` |
| 前端构建失败 | 先单独运行 `npm run build` 定位问题 |
| icon 文件缺失 | 确认 `src-tauri/icons/icon.ico` 存在 |

---

## P7: Web E2E 自动化测试

### 框架

- Playwright（推荐）：跨浏览器、自动等待、截图对比

### 安装

```bash
npm install -D @playwright/test
npx playwright install chromium
```

### 配置文件

创建 `playwright.config.ts`：

```typescript
import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  retries: 1,
  use: {
    baseURL: 'http://localhost:5173',
    screenshot: 'only-on-failure',
    trace: 'on-first-retry',
  },
  webServer: {
    command: 'npm run dev',
    port: 5173,
    reuseExistingServer: true,
  },
})
```

### 测试用例设计

| 场景 | 文件 | 验证点 |
|------|------|--------|
| 应用启动 | `e2e/app-launch.spec.ts` | 页面加载、标题正确、布局完整 |
| 文件拖放上传 | `e2e/file-upload.spec.ts` | 拖入 ZIP/TXT/CSV/JSON/LOG 文件触发解压/解析 |
| 归档面板 | `e2e/archive-panel.spec.ts` | 归档列表展示、展开/折叠、删除 |
| 文件树导航 | `e2e/file-tree.spec.ts` | 树节点渲染、点击打开标签 |
| 标签页管理 | `e2e/tab-management.spec.ts` | 打开/关闭/切换标签页 |
| 文件预览 | `e2e/file-preview.spec.ts` | TXT/CSV/JSON/LOG 渲染器正确展示 |
| 全局搜索 | `e2e/global-search.spec.ts` | Ctrl+K 唤起、输入搜索、结果导航 |
| 属性面板 | `e2e/property-panel.spec.ts` | 文件元数据展示 |
| 主题切换 | `e2e/theme-switch.spec.ts` | 深色/浅色主题切换 |
| 面板布局 | `e2e/panel-layout.spec.ts` | 侧栏折叠/展开、宽度拖拽 |

### 执行命令

```bash
# 全量 E2E
npx playwright test

# 指定浏览器
npx playwright test --project=chromium

# 带 UI 调试
npx playwright test --ui

# 生成报告
npx playwright show-report
```

### 通过标准

- 所有 spec 文件通过
- 无超时或断言失败
- 截图无异常（可选视觉回归）

---

## 测试数据

项目 `data/` 目录提供测试用文件：

| 文件 | 用途 |
|------|------|
| `data/sample.txt` | 文本解析测试 |
| `data/sample.csv` | CSV 解析测试 |
| `data/sample.json` | JSON 解析测试 |
| `data/sample.log` | 日志解析测试 |
| `data/data.zip` | ZIP 解压测试 |
| `data/data2.zip` | 多文件 ZIP 测试 |
| `data/data_fail.zip` | 损坏 ZIP 错误处理测试 |
| `data/employees_10000.csv` | 大文件性能测试 |
| `data/mock_10000.csv` | 大数据量渲染测试 |

---

## CI/CD 集成建议

```yaml
# GitHub Actions 示例
name: 全流程测试
on: [push, pull_request]

jobs:
  test:
    runs-on: windows-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 24
      - run: npm ci
      - run: npx vitest run --coverage
      - run: npx vue-tsc --noEmit
      - run: npm run build

  rust:
    runs-on: windows-latest
    steps:
      - uses: actions/checkout@v4
      - uses: dtolnay/rust-toolchain@stable
      - run: cargo check
        working-directory: src-tauri
      - run: cargo test
        working-directory: src-tauri

  e2e:
    runs-on: windows-latest
    needs: test
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 24
      - run: npm ci
      - run: npx playwright install chromium
      - run: npx playwright test

  build-exe:
    runs-on: windows-latest
    needs: [test, rust]
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 24
      - uses: dtolnay/rust-toolchain@stable
      - run: npm ci
      - run: npm run tauri:build
      - uses: actions/upload-artifact@v4
        with:
          name: exe-output
          path: src-tauri/target/release/bundle/
```

---

## 执行记录模板

Agent 每次执行全流程测试后，按以下格式记录结果：

```
## 测试执行记录

- 执行时间：YYYY-MM-DD HH:mm
- 执行环境：Windows / Node vXX / Rust vX.XX

| 阶段 | 状态 | 耗时 | 备注 |
|------|------|------|------|
| P1 单元测试 | ✅/❌ | Xs | N 文件 / M 用例 |
| P2 类型检查 | ✅/❌ | Xs | |
| P3 Web 构建 | ✅/❌ | Xs | 产物大小 |
| P4 Rust 检查 | ✅/❌ | Xs | |
| P5 Rust 测试 | ✅/❌ | Xs | |
| P6 EXE 打包 | ✅/❌ | Xs | EXE 大小 |
| P7 E2E 测试 | ✅/❌ | Xs | N 场景 |

### 修复记录（如有）

- [文件路径]: 问题描述 → 修复方式
```

---

## 附录：npm scripts 速查

| 命令 | 说明 |
|------|------|
| `npm run dev` | 启动 Vite 开发服务器（Web） |
| `npm run tauri:dev` | 启动 Tauri 桌面开发模式 |
| `npm test` | 运行全量单元测试 |
| `npm run test:watch` | Watch 模式单元测试 |
| `npm run typecheck` | TypeScript 类型检查 |
| `npm run build` | 生产构建（Web） |
| `npm run tauri:build` | 打包桌面 EXE |
| `npx playwright test` | E2E 自动化测试 |
