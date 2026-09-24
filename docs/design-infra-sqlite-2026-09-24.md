# Hello-Tauri 基础设施与 SQLite 存储设计

- 日期：2026-09-24
- 状态：**待评审**（评审通过后再改代码）
- 关联：`docs/design-single-file-storage-2026-09-23.md`、`docs/analysis-2026-09-23.md`

## 0. 需求映射

| # | 需求 | 本文档对应章节 |
| --- | --- | --- |
| 1 | 引入 SQLite 存二维数据 | §4 数据层 |
| 2 | 引入 JSON 配置存系统配置（存储目录 / 标题描述 / 核心配置） | §5 配置层 |
| 3 | 建基础设施组件（DB ORM 交互、文件读写等），业务基于其上扩展 | §2 分层、§6 组件清单 |

## 1. 可行性验证（PoC，已完成）

引入 SQLite 前，先验证它能穿过本项目最硬的约束：**MSVC + `crt-static` + 内网 `--offline`**。

独立 PoC（rusqlite bundled + 与项目相同的 `.cargo/config.toml` 与 release profile）结果：

| 判据 | 结果 |
| --- | --- |
| 在 `+crt-static` 下能否编译 | ✅ 通过（`cc` crate 调 MSVC `cl.exe` 编译内置 sqlite C） |
| 运行期正确性 | ✅ 建表/插入/查询 `OK [(1, "x")]` |
| 产物的外部 DLL 依赖 | ✅ 仅 3 个系统 DLL（`ntdll`/`kernel32`/`api-ms-win-core-synch`），sqlite 引擎**完全静态内联** |
| 体积增量 | 裸 console 程序 0.4 MB → 含 sqlite 1.24 MB（**+0.8 MB**） |
| 内网离线 | ✅ 全套 crate 已落入本地 cargo 缓存，`--offline` 可复用 |

**结论：SQLite 不破坏单文件承诺。** 这是后续所有选型的前提，已排除在实现阶段翻车的风险。

## 2. 分层架构（现状 → 目标）

现状是「薄桥接」三层。本次在 `src/api` 与 `src/stores` 之间插入**数据访问层**，并把 Rust 侧从"几个写死的命令"升级为"通用基础设施通道"。

```
目标分层（自上而下）
┌─────────────────────────────────────────────────────────┐
│ views/            Vue 页面（消费 store）                   │
├─────────────────────────────────────────────────────────┤
│ stores/           业务状态（Pinia，持有业务规则）           │
├─────────────────────────────────────────────────────────┤
│ repositories/     【新增】数据访问对象 DAO，SQL 在这里      │  ← 业务查询归 TS
│   tableRepo.ts      tableRepo / configRepo / logRepo …    │
├─────────────────────────────────────────────────────────┤
│ infra/            【新增】基础设施抽象（宿主无关接口）       │  ← 统一契约
│   db.ts fs.ts config.ts log.ts                            │
├─────────────────────────────────────────────────────────┤
│ api/ (Bridge)     宿主边界：tauri.ts ↔ Rust / web.ts ↔ 浏览器│
└─────────────────────────────────────────────────────────┘
                          │ invoke
┌─────────────────────────────────────────────────────────┐
│ src-tauri/src/    Rust 基础设施（通用，不含业务）           │
│   db.rs  通用 SQL 执行通道 + 迁移引擎                       │
│   fs.rs  存储目录内文件读写                                 │
│   config.rs 系统配置(引导+分层)  storage.rs 目录解析/迁移    │
│   log.rs 日志                                              │
└─────────────────────────────────────────────────────────┘
```

**关键原则（延续既有铁律）**：Rust 只提供**通用能力**（执行一条参数化 SQL、读写一个文件），**不感知任何业务表**。新增业务功能 = 在 `repositories/` 写 SQL，Rust 一行不改。

## 3. 依赖选型决策

| 候选 | 决策 | 理由 |
| --- | --- | --- |
| **rusqlite (bundled)** | ✅ **采用** | 同步 API、薄、`crt-static` 已 PoC 通过、体积仅 +0.8 MB、完全静态内联 |
| tauri-plugin-sql | ❌ 不采用 | 底层 sqlx+tokio 异步栈，`crt-static` 兼容**未验证**（tokio 在 static CRT 下历史上踩坑）；DB 路径锁死 `BaseDirectory::AppConfig`，与"存储目录可配置"冲突；拖入整套 tokio 增体积 |
| diesel | ❌ 不采用 | 面向多后端、需额外编译依赖，客户端内嵌库过重 |
| SeaORM | ❌ 不采用 | 基于 sqlx，同样异步 + 多驱动，违背"Rust 最小化" |

ORM 层次：**不引重型 ORM**。rusqlite 之上写一层**极薄的仓储抽象**（TS 侧 Repository 模式 + Rust 侧通用 SQL 通道）。理由见 §6——把 SQL 留在 TS 既贴合"主力语言 TS"，又让 Rust 保持通用与稳定。

## 4. 数据层设计（SQLite）

### 4.1 存储位置

数据库文件落在**可配置的存储根**下：`{dataDir}/data/app.db`（WAL 模式的 `-wal`/`-shm` 同级）。`dataDir` 见 §5。

### 4.2 Rust 通道契约

```rust
// 通用能力，不绑定业务表
db_execute(sql, params)  -> { rowsAffected, lastInsertId }   // INSERT/UPDATE/DELETE/DDL
db_select(sql, params)   -> Vec<Map<String, Value>>          // SELECT，按列名返回
db_transaction(ops[])    -> [{rowsAffected}...]              // 一个事务内按序执行多条
db_migrate(migrations[]) -> { applied:[i32] }                // 版本化迁移，内部记 _migrations 表
```

- 参数一律走 rusqlite 占位符绑定（`?1 ?2 …`），不做字符串拼接。
- `Value` 列类型映射：INTEGER→number、REAL→number、TEXT→string、BLOB→base64、NULL→null。
- 单连接 + `Mutex`（rusqlite `Connection` 非 `Sync`）；桌面单机并发极低，够用。

### 4.3 迁移引擎

迁移 SQL 由 TS 侧维护为**有序列表**，Rust 用 `_migrations(version PK, name, applied_at)` 表跟踪已应用版本，只跑未应用的、**每个迁移在事务内**。schema 演进不改 Rust。

### 4.4 二维数据表（业务）

`repositories/tableRepo.ts` 定义示例业务表：

```sql
CREATE TABLE records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL, category TEXT NOT NULL, status TEXT NOT NULL,
  amount REAL NOT NULL DEFAULT 0, owner TEXT NOT NULL, created_at TEXT NOT NULL
);
```

`tableStore` 从"内存数组 + 全量写 JSON"改为"调 tableRepo 的分页/增删改查 + 缓存当前页"。筛选、分页下推到 SQL（`LIMIT/OFFSET`、`WHERE`），不再全量载入——**这是引入 DB 对性能的实际收益**。

### 4.5 数据日志

`append_log` 目前是写文件。保留文件日志（人类可读、崩溃也留痕），**同时**新增 `logs` 表存结构化日志供界面查询/导出。两者并存：文件为运维，DB 为可查询。

## 5. 配置层设计（JSON）

### 5.1 引导配置问题（必须解决）

"配置里存放存储目录，而配置又在存储目录里" 是自引用悖论。解法：**引导文件固定在系统默认位置**，它只存"真实数据根指向哪"。

```
%APPDATA%\com.taowd.hello-tauri\bootstrap.json   ← 固定，仅存 { "dataDir": "D:\\TangYuan" }
        │  启动读它 → 解析出 dataDir
        ▼
{dataDir}\config\app.json                         ← 真正的系统配置（大）
{dataDir}\data\app.db                              ← SQLite
{dataDir}\logs\app-YYYY-MM-DD.log                  ← 日志
```

- 首启无 bootstrap → 用默认 `D:\TangYuan`（探针可写检测，沿用现有回退逻辑），写 bootstrap。
- 用户改 `dataDir` → 见 §5.3 迁移。

### 5.2 系统配置 schema（`app.json`）

分三段，UI 暴露的"偏好"与"部署期配置"分离：

```jsonc
{
  "meta":     { "title": "Hello-Tauri", "description": "…", "version": "0.1.0" }, // 标题/描述(需求2)
  "storage":  { "dataDir": "D:\\TangYuan", "logKeepDays": 30 },
  "prefs":    { "theme": "light", "pageSize": 10, "autoSave": true,
                "sidebarCollapsed": false, "defaultRoute": "/" }                    // 现有 AppSettings 归此
}
```

现有 `AppSettings`（5 字段）平滑并入 `prefs`；`meta`/`storage` 是新增。配置读写走 `infra/config.ts`，缓存 + 脏标记 + 批量落盘，避免每个 keystroke 写盘。

### 5.3 改存储目录的迁移策略

`dataDir` 变更时（Rust `config_set` 内）：**先把 `app.db`（含 `-wal`/`-shm` checkpoint 后）与 `config/`、`logs/` 整体复制**到新目录，验证成功后原子改 bootstrap 指向，旧目录**保留不删**（安全）。任一环节失败回滚，绝不半迁移。→ 见决策点 Q2。

## 6. 基础设施组件清单

### Rust 侧（`src-tauri/src/`，通用、无业务）
| 模块 | 命令 | 职责 |
| --- | --- | --- |
| `db.rs` | db_execute/select/transaction/migrate | SQLite 通道（rusqlite） |
| `config.rs` | config_get/set | 分层系统配置 + bootstrap |
| `storage.rs` | storage_info / 目录迁移 | dataDir 解析、可写探针、迁移 |
| `fs.rs` | fs_read/fs_write（限 storage 内，防穿越） | 通用文件读写（需求3"文件读写"） |
| `log.rs` | append_log | 文件日志 + DB 日志双写 |

### TS 侧
| 模块 | 职责 |
| --- | --- |
| `infra/db.ts` `fs.ts` `config.ts` `log.ts` | 对 Bridge 的类型化封装，暴露 Promise API |
| `api/`（Bridge） | 扩 `dbExecute/dbSelect/configGet/configSet/fsRead/fsWrite` 等；web 侧给可跑的实现（§7） |
| `repositories/` | DAO：SQL 与行→对象映射。`tableRepo`、`metaRepo`… |
| `types/` | `SystemConfig`、`RecordRow`（原 TableRow）等 |

## 7. 浏览器调试模式（`web.ts`）

Web 模式定位仍是"无 Rust 环境调试 UI"，**不引入真 SQL 引擎**（sql.js 要拉 wasm、违背零外部资源）。策略：`infra/` 与 `repositories/` 定义**语义化接口**（`list(query)`、`create(draft)`…），web 适配器用**内存 + localStorage** 实现同样语义，tauri 适配器翻译成 SQL。业务/store 只依赖语义接口，不感知底层是 SQL 还是 JSON。→ 决策点 Q3 决定是否给 web 侧也做到分页/筛选下推的等价行为。

## 8. 对现有功能的迁移

| 现有 | 处理 |
| --- | --- |
| `read_table`/`write_table`（table.json 全量） | 移除；改为 SQLite `records` 表。首启若检测到旧 `data/table.json`，一次性导入 `records`（迁移种子里做） |
| `load_config`/`save_config`（config.json=AppSettings） | 升级为分层 `app.json` + `bootstrap.json`；旧 config.json 自动并入 `prefs` |
| `D:\TangYuan` 硬编码首选根 | 变为 `storage.dataDir` 默认值，仍可配 |
| Bridge 3→8 方法 | 再扩到 db/config/fs 通道；tauri 与 web 两侧同步 |

## 9. 分期实施（每期独立可验证、可提交）

1. **P0 安全网**：先给现有 `stores/table.ts` 补 vitest 单测（改存储契约前的护栏，也是分析报告 P1）。
2. **P1 基础设施·DB**：Rust `db.rs`（rusqlite 通道 + 迁移引擎）→ Bridge `db*` → `infra/db.ts`；PoC 级 CRUD 打通。
3. **P2 配置层**：`bootstrap.json` + `app.json` 分层 + `storage.rs` 目录可配 + 旧数据迁移。
4. **P3 业务迁移**：`tableRepo`/`records` 表落地，`tableStore` 改走仓储 + SQL 分页；table.json 导入种子。
5. **P4 fs + 双写日志 + UI**：配置页增"存储目录/迁移"入口，文件读写通道。

每期收尾：`typecheck` + 单测 + 实跑 `npm run pack`（PE 导入表须仍"无 WebView2Loader/VCRUNTIME/UCRT"）。

## 10. 决策点（需你拍板）

| # | 议题 | 推荐 | 理由 |
| --- | --- | --- | --- |
| Q1 | Rust 抽象层次 | **通用 SQL 通道**（SQL 留在 TS） | 最大化"Rust 薄/TS 厚"，新增业务不改 Rust |
| Q2 | 改 dataDir 是否搬数据 | **自动复制迁移、旧目录保留** | 防数据"凭空消失"，可回滚 |
| Q3 | web 模式是否等价实现 SQL | **仅语义等价，不做真 SQL** | 零外部资源、保持调试定位 |
| Q4 | 是否 P0 先补单测 | **是** | 改存储契约无护栏风险高（分析报告 P1） |

> 另需你知悉的取舍：**不使用** `tauri build`（它会静默丢掉 crt-static，§上一设计文档已证）；SQLite 走 `rusqlite` 而非官方 plugin，因后者路径锁死且异步栈对 `crt-static` 未验证。