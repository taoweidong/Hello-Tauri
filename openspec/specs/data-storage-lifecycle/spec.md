# data-storage-lifecycle Specification

## Purpose

数据存储生命周期：数据根目录（默认 `D:\TangYuan`，可迁移）→ 引导文件 → 版本化
迁移 → 日志保留。所有持久化数据只落本机（内网离线是硬需求），存储链路的可靠性
直接决定用户对「我的数据在哪、丢没丢」的信任。所有需求描述已实现且被测试钉住
的行为（来源：`orchestrator/bootstrap.spec.ts`、uitest 54 用例、`src-tauri` 存储链路）。

## Requirements

### Requirement: 引导文件定位数据根

真实数据根 SHALL 由固定引导文件 `%APPDATA%\com.taowd.hello-tauri\bootstrap.json`
指向；子目录（config / data / logs / exports）在数据根下自动创建。来源：
uitest「存储根展示为沙箱目录（bootstrap 指针生效）」用例。

#### Scenario: 引导指针生效

- **WHEN** bootstrap.json 指向某个目录且应用启动
- **THEN** 存储布局（configFile / dbFile / logsDir）全部解析到该目录之下

### Requirement: 首选目录不可写时降级回退并告警

首选数据根不可写时 SHALL 回退到 `%APPDATA%` 兜底目录，且 MUST 在 UI 显式给出
「存储位置已回退」告警——静默降级会让用户在错误的位置找数据。来源：
uitest「首选目录不可写时回退到 %APPDATA% 并给出告警」用例。

#### Scenario: 首选盘不可写

- **WHEN** D 盘不可写时应用启动
- **THEN** 存储回退到用户目录、布局标记 fallback=true、UI 出现降级告警

### Requirement: 版本化迁移幂等且注册表唯一

Schema 迁移 SHALL 由 TS 侧维护（Rust 只做通用执行器）：版本列表集中在唯一注册表
（MIGRATIONS），宿主侧 `_migrations` 表跟踪已应用版本，重复调用不重跑；失败清缓存
允许重试。来源：`orchestrator/bootstrap.spec.ts`、uitest「app.db 表结构与迁移记录完整
（迁移 v1-v3）」。

#### Scenario: 重复迁移

- **WHEN** 应用多次启动、每次都触发迁移
- **THEN** 只有未应用过的版本被执行，已建表结构不被破坏

### Requirement: 迁移窗口拒绝写入

存储根复制迁移期间与完成后的重启前，配置/日志/表格写入 MUST 被拒绝（复制窗口内
写入会落在被复制的旧根、重启后「消失」）。来源：`src-tauri/commands.rs`
`check_file_writes_allowed`（评审 P1）。

#### Scenario: 迁移中保存配置

- **WHEN** 存储根复制迁移进行中时前端发起 saveConfig
- **THEN** 写入被拒绝并返回明确错误，数据不落到旧根

### Requirement: 存储根复制迁移旧目录保留

存储根迁移 SHALL 采用复制迁移：数据完整复制到新根、旧目录原样保留，迁移完成后
需重启生效。来源：`src-tauri/commands.rs` storage_migrate + uitest 沙箱用例。

#### Scenario: 迁移到新目录

- **WHEN** 用户在设置页把存储根迁移到新路径
- **THEN** 全量数据复制到新根（含 app.db / WAL / 日志）、旧目录保留、提示重启生效

### Requirement: 日志按天落盘且保留 30 天

运行日志 SHALL 按本地日期写 `logs/app-YYYY-MM-DD.log`，保留策略为 30 天滚动清理；
日志失败不阻断业务（静默降级）。来源：uitest「日志文件按本地日期命名且含时间戳」、
`retention.ts` 用例。

#### Scenario: 日志写入与清理

- **WHEN** 应用运行并产生日志、清理任务执行
- **THEN** 当日文件含本地时间戳行；超过 30 天的日志文件被删除，业务不受影响

### Requirement: 运行时零外部请求

应用运行时 SHALL 不发起任何外部网络请求（无 CDN 字体/图标/更新检查）——内网
离线是硬需求；打包产物为单文件 exe（外部依赖仅为 Windows 系统自带 DLL）。来源：
uitest「运行期间无 CSP 违规/无未捕获异常」+ `npm run pack` 的 PE 导入表硬校验。

#### Scenario: 断网运行

- **WHEN** 机器完全断网时应用运行全功能
- **THEN** 无网络请求失败、无功能降级（除依赖外网的能力本就不存在）
