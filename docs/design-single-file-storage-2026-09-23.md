# 单文件 exe + 统一数据目录改造方案

- 日期：2026-09-23
- 状态：**已实施并验证**
- 关联：`docs/analysis-2026-09-23.md`

## 一、需求拆解

用户提出四件事：

1. `src-tauri/target` 移动到项目根 `target/`
2. 打包切换到 MSVC 工具链，静态链接 `WebView2Loader.dll`，产出真正单文件 exe
3. 数据、配置、日志统一存到 `D:\TangYuan`
4. 程序支持修改该目录内容，且有权限写入

## 二、关键实测发现（颠覆了原假设）

### 2.1 MSVC 工具链本来就是当前默认

```
rustup show → stable-x86_64-pc-windows-msvc (active, default)
rustc -vV   → host: x86_64-pc-windows-msvc
```

**无需切换**。原需求担心的 GNU 工具链场景并不存在。

### 2.2 `WebView2Loader.dll` 早已静态链接

`webview2-com-sys-0.38.2/src/lib.rs:13-22` 的宏是决定性证据：

```rust
#[cfg_attr(target_env = "msvc",      link(name = "WebView2LoaderStatic", kind = "static"))]
#[cfg_attr(not(target_env = "msvc"), link(name = "WebView2Loader.dll"))]
```

即：**MSVC 下静态链接、非 MSVC 下动态链接**。对旧 exe 的 PE 导入表实测确认——只列到
`ntdll/kernel32/user32` 等系统 DLL，`WebView2Loader.dll` 字符串完全未命中。

结论：需求 2 中「切换到 MSVC」这一项**已是事实**，真正需要补的是下面 2.3。

### 2.3 但存在一个被忽略的隐性依赖：`VCRUNTIME140.dll`

改造后首次 release 编译，导入表出现：

```
VCRUNTIME140.dll
VCRUNTIME140_1.dll
```

这两个是 **VC++ 运行时可再发行组件**，目标机若未安装 VC++ Redistributable 就无法启动。
它同样破坏「单文件、不依赖其他文件」的目标，且比 `WebView2Loader.dll` 更隐蔽
（旧 exe 恰好没暴露，因为我最初的对比基线里有它）。

**修复**：在 `.cargo/config.toml` 加入静态 CRT：

```toml
[target.x86_64-pc-windows-msvc]
rustflags = ["-C", "target-feature=+crt-static"]
```

效果：可分发 DLL 依赖 **22 个 → 13 个**，剩余全部为 Windows 系统自带。

### 2.4 日志时间戳的依赖陷阱

日志需要本地时区时间戳。**首选 `chrono`，但被否决**：

- `chrono 0.4.45` 虽在 `Cargo.lock` 中且源码已缓存，但它的必需传递依赖
  `iana-time-zone` **不在下载缓存中**（仅有 index 元数据）。
- 引入它会让内网 `cargo build --offline` 失败，破坏「打包过程不访问公网」的硬约束。

**替代方案**：直接用已在依赖树内、源码已缓存的 `windows-sys 0.61.2` 调 Win32 `GetLocalTime`，
零新依赖、零下载。非 Windows 目标用纯 std 的 civil-from-days 算法兜底，保证可编译。

## 三、实施清单

### 3.1 编译产物迁移

| 项 | 改动 |
| --- | --- |
| 新建 `.cargo/config.toml` | `[build] target-dir = "target"` |
| 移动目录 | `src-tauri/target/` → `target/`（1.7 GB 原地重命名） |
| `.gitignore` | 增加 `target/`（原规则只写了 `src-tauri/target/`，新目录会漏进版本库） |
| `scripts/build.mjs` | 产物路径 `src-tauri/target/release` → `target/release` |

### 3.2 单文件保证固化

单文件需要**两层**保证，缺一不可：

| 层 | 消除的依赖 | 手段 |
| --- | --- | --- |
| MSVC 工具链 | `WebView2Loader.dll` | `webview2-com-sys` 的 `cfg(target_env="msvc")` 分支 |
| 静态 C 运行时 | `VCRUNTIME140.dll`、`api-ms-win-crt-*.dll` | `-C target-feature=+crt-static` |

`.cargo/config.toml` 写入：

```toml
[build]
target-dir = "target"

[target.x86_64-pc-windows-msvc]
rustflags = ["-C", "target-feature=+crt-static"]
```

#### 踩坑记录一：`tauri build` 会覆盖 `.cargo/config.toml` 的 rustflags

实测发现同一份配置下两条路径结果不同：

| 构建路径 | 外部 DLL 数 | crt-static |
| --- | --- | --- |
| `cargo build --release --features tauri/custom-protocol` | **13** | 生效 |
| `tauri build` | **20**（含 `api-ms-win-crt-*`） | **失效** |

排查：在 Tauri CLI 原生模块 `cli.win32-x64-msvc.node` 中检索字符串，确认它给 Rust
子进程注入 `CARGO_TARGET_<TRIPLE>_RUSTFLAGS`。Cargo 优先级里**环境变量高于
`.cargo/config.toml`**，把仓库的 `+crt-static` 顶掉了。进一步实测：即便从 `npm run pack`
一侧显式设置同名环境变量强行覆盖，**依然穿透不进 tauri 的子进程**（产物仍是 20 DLL）——
tauri CLI 在更内层重设了它。结论：**只要走 `tauri build`，就无法稳定保证 crt-static。**

#### 最终方案：桌面编译绕开 `tauri build`，直接 `cargo build`

```js
run('cargo', ['build', '--release', '--features', 'tauri/custom-protocol', '--offline',
              '--manifest-path', join('src-tauri', 'Cargo.toml')], '桌面编译 (cargo build · 生产模式)')
```

三条理由，都与单文件直接相关：

1. **纯 `cargo build` 严格遵循 `.cargo/config.toml`**，`+crt-static` 稳定生效（13 DLL）。
2. **生产模式靠 feature 而非 CLI**：tauri v2 的 dev/生产语义在 `tauri/build.rs` 里就是
   `let dev = !custom_protocol`。不传 `tauri/custom-protocol` 的裸 `cargo build` 是 dev 模式、
   **资源不内嵌**（实测：assets 键命中 0/10）。显式传该 feature 即进入生产模式
   （实测：assets 键命中 10/10）。这解释了为什么不能想当然地"直接 cargo build 就行"。
3. **不再有重复构建**：裸 cargo 没有 `beforeBuildCommand`，前端由脚本显式构建一次。

#### 踩坑记录二：`cargo build` 的 dist 陈旧风险 → 强制重编

`generate_context!` 是过程宏，只在 **crate 重编译**时重新读取并内嵌 `dist/`。而
tauri-build 的 `build.rs` 只 `rerun-if-changed` 了 `tauri.conf.json` 与 `capabilities`，
**不含 `dist/`**（tauri-codegen 也没用 `proc_macro::track_path` 跟踪前端资源）。

后果：若某次仅前端变更、Rust 未变，`cargo build` 会判定 crate 未过期，直接把**过期资源**
打进 exe。由于 `pack` 每次都会重建前端，这里在编译前 touch 一下 `lib.rs` 强制重编：

```js
const now = new Date()
utimesSync(join(root, 'src-tauri', 'src', 'lib.rs'), now, now)
```

代价是多一次 crate 重编（依赖不重建，约 1 分钟），换来的是"产物永远内嵌最新前端"的确定性。

#### 产物层硬校验：`assertSingleFile`

构建完成后**解析 PE 导入表**，命中 `webview2loader.dll` / `vcruntime*` / `msvcp*` /
`api-ms-win-crt-*` 任一即判失败退出。这是真正的护栏：**配置写得再对，也以产物实测为准**——
尤其 tauri build 那种失效模式是**静默**的。符合「证据优于声称」。

`scripts/build.mjs` 另加 MSVC 断言：读取 `rustc -vV` 的 `host`，非 MSVC 直接报错退出。
GNU 工具链会链接 `WebView2Loader.dll`，属于「必须显式拦截」的错误。

#### 顺带修掉：前端被构建两遍

原 `pack` 流程是：

```
npm run typecheck → npm run build:web → npm run tauri -- build
                                        └─ beforeBuildCommand: npm run build:web  ← 又一遍
```

`tauri.conf.json` 的 `beforeBuildCommand` 本身就是 `npm run build:web`，因此前端被
构建了两次，`vite` 的 `emptyOutDir` 也随之执行两遍。已从 `build.mjs` 移除显式的
`build:web` 调用，前端构建统一交由 `tauri build` 负责。收益：打包耗时减少约一半的
前端构建开销，并消除一次无意义的 dist 清空。

### 3.3 存储层改造

**Rust 侧**（`src-tauri/src/commands.rs`）新增存储布局解析与 8 个命令：

| 命令 | 作用 |
| --- | --- |
| `storage_info` | 返回实际生效的存储布局 |
| `load_config` / `save_config` | 读写 `config/config.json` |
| `read_table` / `write_table` | 读写 `data/table.json` |
| `append_log` | 追加日志到 `logs/app-YYYY-MM-DD.log` |
| `open_storage_dir` | 用 explorer 打开数据目录（不引入插件） |
| `app_info` | 应用信息 + 存储布局 |

目录结构（分子子目录，用户选定）：

```
D:\TangYuan\
├── config\config.json
├── data\table.json
└── logs\app-2026-09-23.log
```

**可写性判定**：真探测，不是 `exists()` 检查——

```rust
fs::create_dir_all(dir)?;
fs::write(&probe, b"ok")?;      // 目录存在但只读同样会被抓出
fs::remove_file(&probe)?;
```

**降级策略**（用户选定「自动回退」）：`D:\TangYuan` 不可用时回退到
`%APPDATA%\com.taowd.hello-tauri`，前端以 `storageWarning` 计算属性暴露，
「配置」页顶部显示警告条列出**实际路径 + 回退原因**。程序永远能启动。

**日志防爆**：单条日志按 UTF-8 字符边界截断到 4000 字符；日志文件按日期命名，
字典序即时序，保留最近 30 份，超出后删最旧。

**路径安全**：路径完全由 Rust 侧决定，不接受前端传参，杜绝路径穿越。

### 3.4 前端改造

| 文件 | 改动 |
| --- | --- |
| `src/types/index.ts` | 新增 `StorageLayout`、`LogLevel`；`AppInfo` 增加 `storage` |
| `src/api/types.ts` | Bridge 从 3 方法扩到 8 方法 |
| `src/api/tauri.ts` / `web.ts` | 两侧同步实现新方法（契约一致） |
| `src/utils/logger.ts` | **新增**：统一日志出口，控制台 + 落盘，失败静默 |
| `src/stores/app.ts` | 加载存储布局、暴露 `storageWarning`、日志改用 logger |
| `src/stores/table.ts` | 表格数据加载/持久化；自增 ID 计数器 |
| `src/views/SettingsView.vue` | 新增「数据存储」面板、打开目录按钮、降级警告条 |
| `src/App.vue` | 启动时加载表格数据；`pageSize` 单向同步 |

### 3.5 顺带修复：P0-1 每页条数双真值

前一版分析（`docs/analysis-2026-09-23.md` P0-1）指出的缺陷，本轮一并修掉：

- **删除** `src/stores/table.ts` 里的 `pageSize` 副本。
- 真值唯一位于 `appStore.settings.pageSize`，由 `App.vue` 的 `watch` 单向注入表格。
- 表格分页器改用 `:page-size` + `@size-change` 写回**配置源**，而非绑定表格副本。
  这样在表格页调每页条数会被「自动保存」持久化，且与「配置」页永不冲突。

### 3.6 顺带修复：P0-2 `pack.bat` 栈失衡

`scripts/pack.bat` 原有两个 `popd` 走上 `:end`（成功路径第 58 行 + `:end` 第 98 行），
且失败路径从未 `pushd` 却同样 `popd`，会弹掉调用者目录。改为标志位守卫：

```bat
set "PUSHED="
pushd "%ROOT%" 2>nul
if errorlevel 1 goto :err_root
set "PUSHED=1"
...
:end
if defined PUSHED popd 2>nul
```

### 3.7 顺带修复：P2-6 `autoSave` 文案

原文案「修改后立即写入本地」与行为不符（实际需点「仅应用/保存配置」才落盘）。
改为「点「仅应用」或「保存配置」后自动写入本地」。

## 四、验证证据

| 检查项 | 命令 | 结果 |
| --- | --- | --- |
| Rust 编译（离线） | `cargo build --release --features tauri/custom-protocol --offline` | ✅ 退出码 0，零警告 |
| Rust 依赖离线可得 | 同上 `--offline` | ✅ 新依赖 `windows-sys` 已在缓存，无下载 |
| 前端类型 | `npm run typecheck` | ✅ 退出码 0 |
| 完整打包链 | `npm run pack` | ✅ 退出码 0 |
| 单文件（WebView2） | PE 导入表解析 | ✅ **无 `WebView2Loader.dll`** |
| 单文件（CRT） | PE 导入表解析 | ✅ **无 `VCRUNTIME140.dll` / `api-ms-win-crt-*`** |
| 可分发 DLL 依赖总数 | PE 导入表解析 | ✅ 22 → **13**，余者皆系统自带 |
| 前端资源内嵌 | 产物内 assets 键明文检索 | ✅ **10/10 命中**（生产模式确认） |
| **实机运行** | 直接启动发布 exe | ✅ 进程正常启动，GUI 拉起 |
| **`D:\TangYuan` 自动创建** | 启动前后目录对比 | ✅ 启动前不存在，启动后自动建 `logs/` 并写入 `app-2026-09-24.log` |
| **日志内容正确性** | 读回日志 | ✅ `07:05:26.798 [INFO] 应用启动，数据目录 D:\TangYuan`（时间为本地时区，证 `GetLocalTime` 路径正确） |
| **D 盘不可写时回退** | `icacls D:\TangYuan /deny Everyone:(W)` 后重启 | ✅ 回退到 `%APPDATA%\com.taowd.hello-tauri`，日志记 `应用启动（存储降级）：D:\TangYuan 不可用（目录不可写: 拒绝访问。 (os error 5)），已回退到 ...` |
| `target/` 输出位置 | 编译后检查 | ✅ 落在项目根，`src-tauri/target` 未重建 |
| `target/` 版本控制 | `git check-ignore` | ✅ 已被忽略 |

exe 体积：3.37 MB。回退测试完成后已用 `icacls /remove:d` 恢复 `D:\TangYuan` 权限。

## 五、遗留事项

| 项 | 说明 |
| --- | --- |
| 表格数据 / 配置的 UI 级读写 | 存储降级回退（`icacls` 造不可写）实机验证通过；但「在表格里增删改后重启是否保留」这类 UI 级操作需人手点验（沙箱只能启动进程、无法点击 GUI 控件）。持久化代码路径与配置读写一致，风险低。 |
| `data/table.json` 首次运行 | 首次无此文件时沿用内置示例数据，首次变更后才落盘 |
| 浏览器模式的日志 | 仅存内存数组，刷新即清空——这是刻意设计，避免调试模式污染磁盘 |
| CSP 仍为 null | `tauri.conf.json` 的 `security.csp` 未收紧，建议后续单独处理 |
| 无自动化测试 | `stores/table.ts` 现在承载了持久化逻辑，测试优先级进一步上升 |

## 六、为什么把断言写进构建脚本

`.cargo/config.toml` 的 `target-dir` 与 `rustflags` 是**仓库级**配置，会覆盖开发者本地
`.cargo/config.toml`。这带来一个副作用：若团队某成员的本地配置有额外 rustflags，
会被仓库配置取代。此处取舍是**优先保证可复现性** —— 单文件 exe 是本项目的核心交付
承诺，宁可让本地个性化配置让位。

同理，`build.mjs` 里的 MSVC 断言是**失败即停**而非警告：工具链选错会静默产出带外部
DLL 的 exe，等到目标机器上才发现打不开，排查成本远高于构建时直接拦住。