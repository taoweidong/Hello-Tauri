# Hello-Tauri 全量分析与清理方案

- 分析日期：2026-09-25
- 基线：commit `614378d`（main 与 origin/main 同步）
- 方法论：Superpowers（先分析 → 出方案 → 评审确认 → 动手 → 全量验证 → 提交）
- 本轮范围：**删除废弃/冗余代码与文件，保持项目整洁**；不做功能性改动

---

## 一、总体健康度

| 维度 | 现状 | 评价 |
| --- | --- | --- |
| 分层架构 | Bridge 三层解耦，SQL 全在 TS 侧 | ✅ 优秀 |
| 类型安全 | strict + noUnusedLocals，typecheck 零错误 | ✅ |
| 测试 | 5 个 spec 文件 / 43 用例（单测）+ UI 自动化 + 冒烟 | ✅ |
| 验证链 | `npm run verify` 7 阶段全量编排 | ✅ 优秀 |
| 单文件打包 | 双链路冗余（见问题 1） | ⚠️ 需收敛 |
| 废弃代码 | 图标系统双实现并存（见问题 2） | ⚠️ 需清理 |

---

## 二、问题清单（按严重度）

### 废 1 · 打包链路双实现并存，职责重叠严重

**现状**：仓库里存在**两条打包链**，功能 90% 重叠：

| 链路 | 入口 | 产物 | rustflags 配置 | 前端产物目录 |
| --- | --- | --- | --- | --- |
| A（主链路） | `npm run pack` → `scripts/build.mjs` | `release/Hello-Tauri-0.1.0-x64.exe` | 根 `.cargo/config.toml` | `dist/` |
| B（新链路） | `npm run build:exe` → `scripts/build-exe.mjs` | `build/exe/日志解析工具.exe` | `src-tauri/.cargo/config.toml` | `build/web/` |

两链路都做了：MSVC 探测 → 前端构建 → touch lib.rs → cargo build（绕开 tauri build）→ PE 导入表验证 → 资源内嵌验证 → 复制产物。

**根因**：B 是昨天（614378d）刚提交的新脚本，复刻了 A 的全部逻辑但没删 A，形成平行链。B 还有三处自身问题：
1. `spawnSync(..., { shell: true })` —— A 链已用 `cmd /d /s /c` 显式解决 npm/参数分词问题，B 用 shell:true 是已踩过的坑回潮；
2. 产物输出到 `build/exe/`，而 `build/` **未被 .gitignore 忽略**，导致构建产物目录混入未跟踪状态（当前 git status 里 `build/` 就是脏的）；
3. `src-tauri/.cargo/config.toml` 与根 `.cargo/config.toml` **重复定义**同一 rustflags（cargo 按「就近覆盖」取 src-tauri 那份，两份并存易漂移）。

**建议**：**保留 A（`scripts/build.mjs`，npm run pack）为主链路**。理由：
- A 是 README、verify.mjs、pack.bat、docs 三处文档共同引用的链路，是「官方路径」；
- A 的产物校验更完善（PE 解析有 build.mjs + verify.mjs 双实现互为交叉验证）；
- B 唯一增量价值是「中文名产物 + VITE_PLATFORM=tauri + 产物清单 README」，可吸收进 A。

**动作**：删除 `scripts/build-exe.mjs`、`src-tauri/.cargo/config.toml`、package.json 的 `build:exe` 脚本；`.gitignore` 增加 `build/`；build/ 目录整目录不提交。

### 废 2 · 图标系统双实现并存

**现状**：`src/components/` 下两套图标体系同时被 git 跟踪：

| 体系 | 文件 | 被引用情况 |
| --- | --- | --- |
| 旧（icons.ts） | `src/components/icons.ts`（185 行，28 个图标） | **5 个视图 + 1 个布局全在用** |
| 新（icons/ 目录） | `src/components/icons/icon-paths.ts` + `AppIcon.vue` | **零引用**（仅自引用与注释提及） |

Grep 证据：`@/components/icons`（旧）被 MainLayout / Dashboard / TableCrud / Settings / About 引用；`AppIcon`（新）在 src 内零命中。

**根因**：e2b0022「统一 SVG 图标体系」提交了新体系，但只落地了文件、没接线，旧体系继续服务全部页面。

**建议**：**删除新体系（`src/components/icons/` 目录）**。理由：
- 旧体系是活跃代码，删它需要改 6 个文件的 import 并逐图标迁移，风险与收益不成比；
- 新体系零引用，是死代码；
- 两套并存会让后续开发者困惑「该用哪套」。

**动作**：`git rm src/components/icons/AppIcon.vue src/components/icons/icon-paths.ts`。

### 废 3 · `build/` 目录未被忽略，含大量中间产物

**现状**（git status 未跟踪项）：
- `build/app.tsbuildinfo`、`build/node/`（tsbuildinfo、config 编译产物）—— 上次会话的构建中间物；
- `build/test-screenshot-*.png` × 5 —— 7 月 5 日测试截图遗留；
- `build/web/`、`build/exe/`（含 11.4 MB exe）—— B 链路产物。

**动作**：`.gitignore` 增加 `build/` 后整目录留在工作区（exe 是有效产物，不删文件本体，仅从 git 视野消除）。测试截图与 tsbuildinfo 属临时物，随目录忽略一并解决。

### 废 4 · `.codebuddy/` 未被忽略

**现状**：内含 `memory/`、`plans/`（旧会话工作区数据，与 `.workbuddy/` 定位重复）。

**动作**：`.gitignore` 增加 `.codebuddy/`。

### 废 5 · `vite-env.d.ts` 价值存疑但保留

`src/vite-env.d.ts` 是 Vue SFC 类型声明 + vite/client 引用，虽小但支撑 .vue 模块类型推断，**保留**。

---

## 三、顺带修正（非删除项，低风险）

| # | 项 | 动作 |
| --- | --- | --- |
| 修 1 | README 目录结构一节仍只描述 `scripts/build.mjs`，未提 B 链 | 删除 B 链后无需改（README 本就只描述 A） |
| 修 2 | `tauri.conf.json` 的 `bundle.targets: ["nsis"]` 在 `bundle.active=false` 时无意义 | 保留（改配置有触发重编译风险，收益低） |

---

## 四、执行计划（TDD 精神：先确认基线，再动刀，最后全量验证）

| 步骤 | 内容 | 验证方式 |
| --- | --- | --- |
| 0 | 基线确认 | typecheck + vitest 通过（43 用例） |
| 1 | 删除 `scripts/build-exe.mjs` | git rm |
| 2 | 删除 `src-tauri/.cargo/config.toml` | git rm（根 .cargo/config.toml 继续生效，cargo 就近覆盖规则下 src-tauri 缺失则回落到根配置） |
| 3 | 删除 `src/components/icons/`（AppIcon.vue + icon-paths.ts） | git rm，typecheck 应仍零错误（零引用） |
| 4 | package.json 删 `build:exe` 脚本 | npm run 列表核对 |
| 5 | .gitignore 追加 `build/`、`.codebuddy/` | git status 干净 |
| 6 | 清理 `build/node/`、`build/test-screenshot-*.png`、`build/app.tsbuildinfo`（工作区临时物） | 文件删除 |
| 7 | 全量验证 | `npm run verify`（typecheck / vitest / vite build / 打包 / PE 校验 / UI 自动化 / 冒烟） |
| 8 | 提交推送 | 中文提交信息，chore 前缀 |

**影响评估**：
- 删除 B 链不影响 A 链（`npm run pack`）任何环节；
- 删除新图标体系不影响任何运行代码（零引用）；
- 删除 `src-tauri/.cargo/config.toml` 后 rustflags 回落到根 `.cargo/config.toml`（同值，行为不变），A 链 build.mjs 显式 `--manifest-path src-tauri/Cargo.toml`，cargo 会以根 target-dir（target/）输出，与 README 描述一致。

---

## 五、验证矩阵（预期）

| 检查项 | 命令 | 预期 |
| --- | --- | --- |
| 类型检查 | `npm run typecheck` | 0 错误 |
| 单元测试 | `npm run test` | 43 通过 |
| 前端构建 | `npm run build:web` | 通过，无外链 |
| 打包 | `npm run pack` | 单文件 exe + PE 校验通过 |
| UI 自动化 | uitest.mjs | 全用例通过 |
| 冒烟 | smoke.mjs | 通过 |
| git 状态 | `git status` | 干净（无未跟踪垃圾） |
