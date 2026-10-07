# Spec Delta

## MODIFIED Requirements

### Requirement: 存储根复制迁移旧目录保留

存储根迁移 SHALL 采用复制迁移：数据完整复制到新根（含 config / data / logs / knowledge /
exports 子目录）、旧目录原样保留，迁移完成后需重启生效。来源：
`src-tauri/commands.rs` storage_migrate + uitest 沙箱用例。

#### Scenario: 迁移到新目录

- **WHEN** 用户在设置页把存储根迁移到新路径
- **THEN** 全量数据复制到新根（含 app.db / WAL / 日志）、旧目录保留、提示重启生效

#### Scenario: 知识沉淀目录随迁

- **WHEN** 数据根存在 `knowledge/` 目录（沉淀知识文档与清单）时执行存储根迁移
- **THEN** `knowledge/` 目录完整复制到新根，迁移重启后知识库清单与文档可正常读取，旧目录中的沉淀知识原样保留
