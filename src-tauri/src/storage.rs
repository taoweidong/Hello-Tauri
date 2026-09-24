use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

/// 需求指定的数据根目录：配置、数据、日志全部落在这里。
pub(crate) const PREFERRED_ROOT: &str = "D:\\TangYuan";

pub(crate) const CONFIG_SUBDIR: &str = "config";
pub(crate) const DATA_SUBDIR: &str = "data";
pub(crate) const LOGS_SUBDIR: &str = "logs";

pub(crate) const CONFIG_FILE: &str = "config.json";
pub(crate) const TABLE_FILE: &str = "table.json";
pub(crate) const DB_FILE: &str = "app.db";

/// 引导文件：固定放在用户配置目录，只存「真实数据根指向哪」。
/// 解决"数据根目录写在配置里、配置又在数据根目录下"的自引用悖论。
const BOOTSTRAP_FILE: &str = "bootstrap.json";

/// 真实探测目录是否可写：创建目录 -> 写探针文件 -> 删除。
/// 只判断 `exists()` 不够 —— 目录存在但只读同样会导致后续写入失败。
pub(crate) fn probe_writable(dir: &Path) -> Result<(), String> {
    fs::create_dir_all(dir).map_err(|error| format!("创建目录失败: {error}"))?;
    let probe = dir.join(".write-probe");
    fs::write(&probe, b"ok").map_err(|error| format!("目录不可写: {error}"))?;
    fs::remove_file(&probe).map_err(|error| format!("无法删除探针文件: {error}"))?;
    Ok(())
}

#[derive(Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct Bootstrap {
    #[serde(default)]
    data_dir: Option<String>,
}

fn bootstrap_path(app: &AppHandle) -> PathBuf {
    app.path()
        .app_config_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
        .join(BOOTSTRAP_FILE)
}

/// 读引导文件里的 dataDir（缺失/损坏时返回 None，用默认首选根）。
fn read_bootstrap_dir(app: &AppHandle) -> Option<String> {
    let raw = fs::read_to_string(bootstrap_path(app)).ok()?;
    let parsed: Bootstrap = serde_json::from_str(&raw).ok()?;
    parsed.data_dir.filter(|dir| !dir.trim().is_empty())
}

/// 写引导文件。先写临时文件再 rename，保证不会留下半截 JSON。
pub fn write_bootstrap_dir(app: &AppHandle, data_dir: &str) -> Result<(), String> {
    let path = bootstrap_path(app);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("创建引导目录失败: {e}"))?;
    }
    let payload = Bootstrap {
        data_dir: Some(data_dir.to_string()),
    };
    let json = serde_json::to_string_pretty(&payload).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, json).map_err(|e| format!("写引导临时文件失败: {e}"))?;
    fs::rename(&tmp, &path).map_err(|e| format!("替换引导文件失败: {e}"))?;
    Ok(())
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct StorageLayout {
    /// 实际生效的存储根目录
    pub root: String,
    /// 首选目录 D:\TangYuan
    pub preferred_root: String,
    pub config_file: String,
    pub table_file: String,
    pub db_file: String,
    pub logs_dir: String,
    /// 是否发生了降级回退
    pub fallback: bool,
    /// 降级原因（正常时为空串）
    pub note: String,
}

/// 解析存储布局。优先级：
///   1. bootstrap 里用户配置的 dataDir
///   2. 默认首选根 D:\TangYuan
///   3. 均不可写时回退用户配置目录（程序必须永远能启动，回退是兜底而非报错）
pub(crate) fn resolve_storage(app: &AppHandle) -> StorageLayout {
    let configured = read_bootstrap_dir(app).map(PathBuf::from);
    let primary = configured.unwrap_or_else(|| PathBuf::from(PREFERRED_ROOT));
    let mut fallback = false;
    let mut note = String::new();

    let root = match probe_writable(&primary) {
        Ok(()) => primary,
        Err(primary_error) => {
            fallback = true;
            let dir = app
                .path()
                .app_config_dir()
                .unwrap_or_else(|_| PathBuf::from("."));
            match probe_writable(&dir) {
                Ok(()) => {
                    note = format!(
                        "{} 不可用（{primary_error}），已回退到 {}",
                        primary.display(),
                        dir.display()
                    );
                    dir
                }
                Err(fallback_error) => {
                    // 两个位置都不可写：仍返回首选路径，具体读写命令会给出明确错误
                    note = format!(
                        "{} 与 {} 均不可写（{primary_error} / {fallback_error}）",
                        primary.display(),
                        dir.display()
                    );
                    primary
                }
            }
        }
    };

    let config_file = root.join(CONFIG_SUBDIR).join(CONFIG_FILE);
    let table_file = root.join(DATA_SUBDIR).join(TABLE_FILE);
    let db_file = root.join(DATA_SUBDIR).join(DB_FILE);
    let logs_dir = root.join(LOGS_SUBDIR);

    StorageLayout {
        root: root.to_string_lossy().to_string(),
        preferred_root: PREFERRED_ROOT.to_string(),
        config_file: config_file.to_string_lossy().to_string(),
        table_file: table_file.to_string_lossy().to_string(),
        db_file: db_file.to_string_lossy().to_string(),
        logs_dir: logs_dir.to_string_lossy().to_string(),
        fallback,
        note,
    }
}

pub(crate) fn write_file(path: &Path, content: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("创建目录失败: {error}"))?;
    }
    fs::write(path, content).map_err(|error| format!("写入失败: {error}"))
}

pub(crate) fn read_file(path: &Path) -> Result<Option<String>, String> {
    if !path.exists() {
        return Ok(None);
    }
    fs::read_to_string(path)
        .map(Some)
        .map_err(|error| format!("读取失败: {error}"))
}

/// 递归复制目录（含子目录）。返回复制的文件数。
/// 目标已存在的同名文件会被覆盖 —— 迁移语义下这是期望行为（新目录为权威副本）。
fn copy_dir_recursive(from: &Path, to: &Path) -> Result<usize, String> {
    fs::create_dir_all(to).map_err(|e| format!("创建目标目录失败: {e}"))?;
    let mut count = 0usize;
    for entry in fs::read_dir(from).map_err(|e| format!("读取源目录失败: {e}"))?.flatten() {
        let src = entry.path();
        let dst = to.join(entry.file_name());
        if src.is_dir() {
            count += copy_dir_recursive(&src, &dst)?;
        } else {
            fs::copy(&src, &dst).map_err(|e| format!("复制 {} 失败: {e}", src.display()))?;
            count += 1;
        }
    }
    Ok(count)
}

/// 迁移存储根：把当前生效根下的 config/data/logs 整体复制到新根，旧目录保留（Q2）。
/// 调用前需先 checkpoint DB（否则 WAL 模式下 -wal 里可能还有未落盘数据）。
/// 复制成功后写 bootstrap 指向新根。**需重启生效**：本会话仍持有旧路径的连接与句柄。
pub fn migrate_data_dir(app: &AppHandle, new_root: &str) -> Result<MigrateReport, String> {
    let target = PathBuf::from(new_root.trim());
    if target.as_os_str().is_empty() {
        return Err("目标目录不能为空".to_string());
    }

    let current = resolve_storage(app);
    if PathBuf::from(&current.root) == target {
        return Err("目标目录与当前目录相同".to_string());
    }
    probe_writable(&target)?;

    // WAL 检查点：把 -wal 内容刷回主 .db 文件，保证复制的是完整数据。
    let db_checkpointed = crate::db::checkpoint(app);

    let mut copied = 0usize;
    for sub in [CONFIG_SUBDIR, DATA_SUBDIR, LOGS_SUBDIR] {
        let from = PathBuf::from(&current.root).join(sub);
        if from.is_dir() {
            copied += copy_dir_recursive(&from, &target.join(sub))?;
        }
    }

    write_bootstrap_dir(app, new_root.trim())?;

    Ok(MigrateReport {
        from: current.root,
        to: target.to_string_lossy().to_string(),
        copied_files: copied,
        db_checkpointed,
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MigrateReport {
    pub from: String,
    pub to: String,
    pub copied_files: usize,
    /// DB 是否成功做了 WAL 检查点（失败时 -wal 可能未并入主文件）
    pub db_checkpointed: bool,
}